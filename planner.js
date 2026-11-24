// planner.js: the Command Center page type (daily and weekly planner).
//
// index.html owns storage, sync, undo and the page shell; this file only knows a
// page's `planner` object:
//   Planner.normalize(x)  validate saved data (loading, importing, sync)
//   Planner.fresh()       an empty planner with the default focus areas
//   Planner.mount(ctx)    draw the page into ctx.root; ctx = { root, page, save }
//
// Dates are local "YYYY-MM-DD" strings and times are minutes from midnight, so
// nothing shifts with timezones. A repeating activity is stored once as a rule;
// its occurrences are worked out when drawn. Ticking, moving or editing one
// occurrence saves just that day as an activity with `ruleId` + `ruleDate`
// (an override), so finished history never changes when the series is edited.
(function(){
"use strict";

// ---------- constants ----------
var FOCUS = ["work", "gym", "cwes", "side"];
var AREAS = FOCUS.concat(["personal"]);
var AREA_DEF = {
  work:{ name:"work", unit:"h", target:0 },
  gym:{ name:"gym", unit:"sessions", target:4 },
  cwes:{ name:"cwes study", unit:"h", target:7 },
  side:{ name:"side hustle", unit:"h", target:12 }
};
var SUBS = {
  work:["core", "meeting", "flex"],
  gym:["strength", "cardio", "mobility"],
  cwes:["theory", "lab", "revision"],
  side:["idea", "build", "research", "marketing", "monetize"],
  personal:[]
};
var MONEY_SUBS = ["marketing", "monetize"];
var FIELDS = ["title", "area", "sub", "start", "end", "prio", "notes", "due"];
var DOW = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
var DAYNAME = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
var MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
var PRIO = ["", "!", "!!", "!!!"];
var PRIO_NAME = ["none", "low", "medium", "high"];
var PX = 0.8;          // day grid: px per minute (48px an hour)
var SNAP = 15;         // drag and resize snap, minutes
var REFLECT = [["did", "what did I accomplish today?"], ["missed", "what did I fail to complete?"],
  ["distraction", "what was my biggest distraction?"], ["tomorrow", "what should I prioritize tomorrow?"]];
var REVIEW = [["win", "biggest accomplishment this week"], ["wrong", "what went wrong?"], ["learned", "what did I learn?"],
  ["improve", "what should I improve next week?"], ["next", "main priorities for next week"]];

// ---------- small helpers ----------
function rid(){ return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function str(v, max){ return String(v == null ? "" : v).slice(0, max); }
function obj(v){ return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
function arr(v){ return Array.isArray(v) ? v : []; }
function pad(n){ return (n < 10 ? "0" : "") + n; }
function ds(d){ return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function pd(s){ return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
function isDate(s){
  if(typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = pd(s);
  return d.getMonth() === +s.slice(5, 7) - 1 && d.getDate() === +s.slice(8, 10);
}
function addDays(s, k){ var d = pd(s); d.setDate(d.getDate() + k); return ds(d); }
function wd(s){ return (pd(s).getDay() + 6) % 7; }         // Monday = 0
function monday(s){ return addDays(s, -wd(s)); }
function today(){ return ds(new Date()); }
function nowMin(){ var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function hm(m){ return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function parseHm(s){
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if(!m || +m[1] > 24 || +m[2] > 59) return null;
  var v = +m[1] * 60 + +m[2];
  return v <= 1440 ? v : null;
}
function dayLabel(s){
  return DOW[wd(s)] + " " + +s.slice(8, 10) + " " + MON[+s.slice(5, 7) - 1] +
    (s.slice(0, 4) !== today().slice(0, 4) ? " " + s.slice(0, 4) : "");
}
function short(s){ return +s.slice(8, 10) + " " + MON[+s.slice(5, 7) - 1]; }
function hrs(min){ var x = Math.round(min / 6) / 10; return (x % 1 ? x.toFixed(1) : String(x)) + "h"; }
function num(x){ x = Math.round(x * 10) / 10; return x % 1 ? x.toFixed(1) : String(x); }
function mins(it){ return it.start == null ? 0 : it.end - it.start; }
function isFlex(it){ return it.area === "work" && it.sub === "flex"; }
function normTime(v){ return Number.isInteger(v) && v >= 0 && v <= 1440 ? v : null; }

// ---------- data ----------
function normFields(o, t){
  o.title = str(t.title, 120).trim() || "untitled";
  o.area = AREAS.indexOf(t.area) >= 0 ? t.area : "personal";
  o.sub = SUBS[o.area].indexOf(t.sub) >= 0 ? t.sub : "";
  var s = normTime(t.start), e = normTime(t.end);
  if(s != null && e != null && e > s){ o.start = s; o.end = e; } else { o.start = null; o.end = null; }
  if(o.sub === "flex" && o.start == null) o.sub = "core";     // a flex window needs times
  o.prio = (t.prio === 1 || t.prio === 2 || t.prio === 3) ? t.prio : 0;
  o.notes = str(t.notes, 2000);
  if(isDate(t.due)) o.due = t.due;
  return o;
}
function normText(src, keys){
  var out = {};
  Object.keys(obj(src)).forEach(function(d){
    if(!isDate(d)) return;
    var v = obj(src[d]), o = {}, any = false;
    keys.forEach(function(k){ var s = str(v[k[0]], 4000); if(s.trim()){ o[k[0]] = s; any = true; } });
    if(any) out[d] = o;
  });
  return out;
}
function normalize(x){
  x = obj(x);
  var out = { v:1, areas:{} }, a = obj(x.areas);
  FOCUS.forEach(function(k){
    var d = AREA_DEF[k], v = obj(a[k]);
    var unit = (v.unit === "h" || v.unit === "sessions") ? v.unit : d.unit;
    var tg = (typeof v.target === "number" && isFinite(v.target) && v.target >= 0 && v.target <= 200)
      ? Math.round(v.target * 10) / 10 : d.target;
    out.areas[k] = { name:str(v.name, 30).trim() || d.name, unit:unit, target:tg };
  });
  var s = obj(x.settings);
  var hour = function(v, def){ return Number.isInteger(v) && v >= 0 && v <= 1440 && v % 60 === 0 ? v : def; };
  var st = hour(s.dayStart, 360), en = hour(s.dayEnd, 1380);
  if(en <= st){ st = 360; en = 1380; }
  out.settings = { dayStart:st, dayEnd:en,
    maxHours:(Number.isInteger(s.maxHours) && s.maxHours >= 1 && s.maxHours <= 24) ? s.maxHours : 12 };

  var ids = {};
  out.acts = arr(x.acts).filter(function(t){ return t && typeof t === "object" && isDate(t.date); }).map(function(t){
    var o = normFields({ id:str(t.id || rid(), 40), date:t.date, done:!!t.done,
      createdAt:Number.isInteger(t.createdAt) && t.createdAt > 0 ? t.createdAt : 0 }, t);
    if(t.ruleId && isDate(t.ruleDate)){ o.ruleId = str(t.ruleId, 40); o.ruleDate = t.ruleDate; }
    return o;
  }).filter(function(o){
    // one record per id, and one override per occurrence, so import and sync never double anything
    var k2 = o.ruleId ? "r|" + o.ruleId + "|" + o.ruleDate : null;
    if(ids[o.id] || (k2 && ids[k2])) return false;
    ids[o.id] = 1; if(k2) ids[k2] = 1;
    return true;
  });

  var rids = {};
  out.rules = arr(x.rules).filter(function(r){ return r && typeof r === "object" && isDate(r.from) && Array.isArray(r.days); }).map(function(r){
    var o = normFields({ id:str(r.id || rid(), 40) }, r);
    delete o.due;
    o.days = [0, 1, 2, 3, 4, 5, 6].map(function(i){ return !!r.days[i]; });
    o.from = r.from;
    if(isDate(r.until) && r.until >= r.from) o.until = r.until;
    o.skip = arr(r.skip).filter(function(d, i, all){ return isDate(d) && d >= o.from && all.indexOf(d) === i; });
    return o;
  }).filter(function(o){
    if(!o.days.some(Boolean) || rids[o.id]) return false;
    rids[o.id] = 1; return true;
  });

  // the linked streak page: "home", a tracker page id, or "" for none
  var k = obj(x.streak);
  out.streak = { page:str(k.page, 40), rule:k.rule === "pct" ? "pct" : "all",
    pct:(Number.isInteger(k.pct) && k.pct >= 10 && k.pct <= 100) ? k.pct : 80 };
  out.reflect = normText(x.reflect, REFLECT);
  out.reviews = normText(x.reviews, REVIEW);
  out.rest = {};
  Object.keys(obj(x.rest)).forEach(function(d){ if(isDate(d) && x.rest[d]) out.rest[d] = true; });
  out.templates = arr(x.templates).filter(function(t){ return t && (t.kind === "day" || t.kind === "week"); }).map(function(t){
    var n = t.kind === "week" ? 7 : 1, days = arr(t.days);
    var o = { id:str(t.id || rid(), 40), name:str(t.name, 40).trim() || "template", kind:t.kind, days:[] };
    for(var i = 0; i < n; i++) o.days.push(arr(days[i]).slice(0, 80).map(function(b){ var f = normFields({}, obj(b)); delete f.due; return f; }));
    return o;
  });
  return out;
}
function fresh(){ return normalize({}); }

// ---------- occurrences (shared by the page and by index.html's streak link) ----------
function indexOf(P){
  var ix = { byDate:{}, over:{} };
  P.acts.forEach(function(a){
    (ix.byDate[a.date] || (ix.byDate[a.date] = [])).push(a);
    if(a.ruleId) ix.over[a.ruleId + "|" + a.ruleDate] = a;
  });
  return ix;
}
function occurs(r, date){
  return r.days[wd(date)] && date >= r.from && (!r.until || date <= r.until) && r.skip.indexOf(date) < 0;
}
function virt(r, date){
  var o = { virtual:true, key:"v:" + r.id + ":" + date, ruleId:r.id, ruleDate:date, date:date, done:false };
  FIELDS.forEach(function(k){ if(r[k] !== undefined) o[k] = r[k]; });
  return o;
}
function byTime(a, b){
  var x = a.start == null ? -1 : a.start, y = b.start == null ? -1 : b.start;
  return x - y || b.prio - a.prio || (a.end || 0) - (b.end || 0) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
}
function itemsFor(P, ix, date){
  var out = (ix.byDate[date] || []).slice();
  P.rules.forEach(function(r){ if(occurs(r, date) && !ix.over[r.id + "|" + date]) out.push(virt(r, date)); });
  return out.sort(byTime);
}
// a day counts for the linked streak when something was planned and enough of it is done
function countsFor(P, items){
  var total = 0, done = 0;
  items.forEach(function(it){ if(!isFlex(it)){ total++; if(it.done) done++; } });
  if(!total) return false;
  return P.streak.rule === "pct" ? done * 100 >= total * P.streak.pct : done === total;
}
function countDays(P, dates){
  var ix = indexOf(P);
  return dates.map(function(d){ return isDate(d) && countsFor(P, itemsFor(P, ix, d)); });
}
// one line for the tracker's Day card: "4/5 done · cwes study 2h · gym ✓"
function daySummary(P, date){
  var items = itemsFor(P, indexOf(P), date), total = 0, done = 0, by = {};
  items.forEach(function(it){
    if(isFlex(it)) return;
    total++;
    if(it.done){ done++; by[it.area] = (by[it.area] || 0) + mins(it); if(it.area === "gym") by.gymDone = true; }
  });
  if(!total) return "";
  var bits = [done + "/" + total + " done"];
  ["cwes", "side", "work"].forEach(function(a){ if(by[a]) bits.push(P.areas[a].name + " " + hrs(by[a])); });
  if(by.gymDone) bits.push(P.areas.gym.name + " ✓");
  return bits.join(" · ");
}

// ---------- tiny DOM helper (same as finance.js) ----------
function h(tag, attrs, kids){
  var e = document.createElement(tag);
  if(attrs) Object.keys(attrs).forEach(function(k){
    var v = attrs[k];
    if(v == null || v === false) return;
    if(k === "text") e.textContent = v;
    else if(k === "class") e.className = v;
    else if(k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
    else if(k === "value") e.value = v;
    else e.setAttribute(k, v === true ? "" : v);
  });
  (kids || []).forEach(function(c){ if(c != null && c !== false) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
  return e;
}
// two-click buttons, like the rest of the site: arm, then confirm within 3s
function armed(btn, label, act){
  var t = null, orig = btn.textContent;
  btn.addEventListener("click", function(e){
    e.stopPropagation();
    if(!t){ btn.textContent = label; btn.classList.add("armed"); t = setTimeout(function(){ t = null; btn.textContent = orig; btn.classList.remove("armed"); }, 3000); return; }
    clearTimeout(t); act();
  });
  return btn;
}

// ---------- the page ----------
var uiState = {};     // view state per page id; survives redraws and undo
function mount(ctx){
  var p = ctx.page, P = p.planner, root = ctx.root;
  var u = uiState[p.id] || (uiState[p.id] = { view:"day", date:today(), form:null, tplSave:false, flash:"", qarea:"personal" });
  function commit(){ ctx.save(); draw(); }
  function areaName(a){ return a === "personal" ? "personal" : P.areas[a].name; }

  // ----- occurrences -----
  var ix = { byDate:{}, over:{} }, byDate = ix.byDate, over = ix.over;
  function buildIndex(){ ix = indexOf(P); byDate = ix.byDate; over = ix.over; }
  function ruleById(id){ for(var i = 0; i < P.rules.length; i++) if(P.rules[i].id === id) return P.rules[i]; return null; }
  function itemsOn(date){ return itemsFor(P, ix, date); }
  // the linked streak page, as index.html reports it: { title, cur, best } or null
  function linked(){ return P.streak.page && ctx.streakOf ? ctx.streakOf(P.streak.page) : null; }
  function counts(date){ return !!linked() && countsFor(P, itemsOn(date)); }
  function keyOf(it){ return it.virtual ? it.key : it.id; }
  function findItem(key){
    if(!key) return null;
    if(key.slice(0, 2) === "v:"){
      var i = key.lastIndexOf(":"), r = ruleById(key.slice(2, i)), date = key.slice(i + 1);
      if(!r) return null;
      if(over[r.id + "|" + date]) return over[r.id + "|" + date];
      return occurs(r, date) ? virt(r, date) : null;
    }
    for(var j = 0; j < P.acts.length; j++) if(P.acts[j].id === key) return P.acts[j];
    return null;
  }
  function setFields(t, f){ FIELDS.forEach(function(k){ if(f[k] === undefined) delete t[k]; else t[k] = f[k]; }); }
  // a repeating occurrence becomes a saved activity the first time it changes
  function materialize(it){
    if(!it.virtual) return it;
    var a = { id:rid(), date:it.date, done:false, createdAt:Date.now(), ruleId:it.ruleId, ruleDate:it.ruleDate };
    setFields(a, it); delete a.due;
    P.acts.push(a); over[a.ruleId + "|" + a.ruleDate] = a;
    return a;
  }
  function liveRule(it){ return it.ruleId ? ruleById(it.ruleId) : null; }
  function removeAct(a){ var i = P.acts.indexOf(a); if(i >= 0) P.acts.splice(i, 1); }
  function toggle(it){ var a = materialize(it); a.done = !a.done; commit(); }

  // ----- stats -----
  function dayStat(date){
    var s = { total:0, done:0, sched:0, flex:0 };
    itemsOn(date).forEach(function(it){
      if(isFlex(it)){ s.flex += mins(it); return; }
      s.total++; s.sched += mins(it); if(it.done) s.done++;
    });
    return s;
  }
  function weekStats(mon){
    var w = { area:{}, days:[] };
    AREAS.forEach(function(a){ w.area[a] = { sched:0, done:0, count:0, doneCount:0, days:{}, doneDays:{}, subs:{} }; });
    for(var k = 0; k < 7; k++){
      var d = addDays(mon, k), day = { date:d, total:0, done:0, sched:0 };
      itemsOn(d).forEach(function(it){
        if(isFlex(it)) return;
        var A = w.area[it.area], m = mins(it);
        A.sched += m; A.count++; A.days[d] = 1;
        day.total++; day.sched += m;
        if(it.done){
          A.done += m; A.doneCount++; A.doneDays[d] = 1; day.done++;
          var sk = it.sub || "other"; A.subs[sk] = (A.subs[sk] || 0) + m;
        }
      });
      w.days.push(day);
    }
    return w;
  }
  // gym counts days with a ticked session; hours count only ticked, timed blocks
  function actual(w, a){
    var A = w.area[a];
    return P.areas[a].unit === "sessions" ? Object.keys(A.doneDays).length : A.done / 60;
  }
  function scheduled(w, a){
    var A = w.area[a];
    return P.areas[a].unit === "sessions" ? Object.keys(A.days).length : A.sched / 60;
  }
  function fmtVal(a, v){ return P.areas[a].unit === "sessions" ? String(Math.round(v)) : num(v) + "h"; }
  function weekPct(w){
    var parts = FOCUS.filter(function(a){ return P.areas[a].target > 0; });
    if(!parts.length) return null;
    var s = 0;
    parts.forEach(function(a){ s += Math.min(1, actual(w, a) / P.areas[a].target); });
    return Math.round(s / parts.length * 100);
  }

  // ----- draw -----
  var body = null;
  function draw(){
    buildIndex();
    if(u.form && u.form.key && !(u.form.key.slice(0, 2) === "r:" ? ruleById(u.form.key.slice(2)) : findItem(u.form.key))) u.form = null;
    root.innerHTML = "";
    root.appendChild(dashboard());
    root.appendChild(toolbar());
    if(u.form) root.appendChild(form());
    body = h("div", { class:"pl-body" });
    root.appendChild(body);
    ({ day:dayView, week:weekView, focus:focusView, settings:settingsView }[u.view] || dayView)();
  }
  function section(title, kids, extra, cls){
    return h("section", { class:"pl-sec" + (cls ? " " + cls : "") }, [ h("div", { class:"pl-shead" }, [ h("h3", { class:"pl-h", text:title }), extra || null ]) ].concat(kids));
  }
  function pbar(frac, area, over){
    return h("span", { class:"pl-pbar" + (area ? " a-" + area : "") + (over ? " over" : "") },
      [ h("i", { style:"width:" + Math.round(Math.min(1, Math.max(0, frac || 0)) * 100) + "%" }) ]);
  }

  // ===== DASHBOARD (always about today and this week) =====
  function dashboard(){
    var t = today(), w = weekStats(monday(t)), td = dayStat(t);
    var overdue = overdueList(t).length;
    var tiles = [];
    tiles.push(h("div", { class:"pl-tile" }, [
      h("div", { class:"pl-tlabel", text:"today" }),
      h("div", { class:"pl-tval", text:dayLabel(t) }),
      pbar(td.total ? td.done / td.total : 0),
      h("div", { class:"pl-tsub" }, [ (td.total ? Math.round(td.done / td.total * 100) + "% · " : "") + td.done + "/" + td.total + " done",
        overdue ? h("b", { class:"pl-red", text:" · " + overdue + " overdue" }) : null ])
    ]));
    ["gym", "cwes", "side"].forEach(function(a){
      var A = P.areas[a], v = actual(w, a);
      tiles.push(h("div", { class:"pl-tile" }, [
        h("div", { class:"pl-tlabel" }, [ h("i", { class:"pl-sw a-" + a }), A.name ]),
        h("div", { class:"pl-tval", text:fmtVal(a, v) + (A.target ? " / " + fmtVal(a, A.target) : "") }),
        pbar(A.target ? v / A.target : 0, a),
        h("div", { class:"pl-tsub", text:(A.unit === "sessions" ? "sessions" : "hours") + " done this week" })
      ]));
    });
    var wp = weekPct(w);
    tiles.push(h("div", { class:"pl-tile" }, [
      h("div", { class:"pl-tlabel", text:"this week" }),
      h("div", { class:"pl-tval", text:wp == null ? "—" : wp + "%" }),
      h("div", { class:"pl-strip", title:"each day: ticked of planned" }, w.days.map(function(d){
        var f = d.total ? d.done / d.total : 0;
        return h("span", { class:"pl-sday" + (d.date === t ? " now" : ""), title:dayLabel(d.date) + ": " + d.done + "/" + d.total },
          [ h("i", { style:"height:" + Math.round(f * 100) + "%" }) ]);
      })),
      h("div", { class:"pl-tsub" }, (function(){
        var L = linked();
        return L ? [ h("b", { class:"pl-streak", text:"streak " + L.cur }), " · best " + L.best ] : [ "of weekly targets" ];
      })())
    ]));
    // where the week's planned hours go
    var total = 0;
    AREAS.forEach(function(a){ total += w.area[a].sched; });
    var dist = h("div", { class:"pl-dist" }, [
      h("div", { class:"pl-distbar", role:"img", "aria-label":"planned hours this week by area" }, AREAS.filter(function(a){ return w.area[a].sched; }).map(function(a){
        var A = w.area[a];
        return h("i", { class:"a-" + a, style:"flex-grow:" + A.sched, title:areaName(a) + ": " + hrs(A.sched) + " planned, " + hrs(A.done) + " done" });
      })),
      h("div", { class:"pl-legend" }, AREAS.map(function(a){
        var A = w.area[a];
        return h("span", null, [ h("i", { class:"pl-sw a-" + a }), areaName(a) + " " + hrs(A.sched), A.sched ? h("small", { text:" (" + hrs(A.done) + " done)" }) : null ]);
      }).concat([ h("span", { class:"pl-lmuted", text:total ? "planned this week: " + hrs(total) : "nothing planned this week yet" }) ]))
    ]);
    // next few things today (or tomorrow)
    var now = nowMin(), next = itemsOn(t).filter(function(it){ return it.start != null && !it.done && !isFlex(it) && it.end > now; }).slice(0, 3);
    var when = "";
    if(!next.length){ next = itemsOn(addDays(t, 1)).filter(function(it){ return it.start != null && !isFlex(it); }).slice(0, 3); when = "tomorrow "; }
    var nextEl = h("div", { class:"pl-next" }, [ h("span", { class:"pl-h", text:"next" }) ].concat(next.length ? next.map(function(it){
      return h("button", { type:"button", class:"pl-nextit a-" + it.area, onclick:function(){ u.view = "day"; u.date = it.date; openEdit(it); } },
        [ h("i", { class:"pl-sw a-" + it.area }), when + hm(it.start) + " " + it.title ]);
    }) : [ h("span", { class:"pl-lmuted", text:"nothing else scheduled" }) ]));
    return h("div", { class:"pl-dash" }, [ h("div", { class:"pl-tiles" }, tiles), dist, nextEl ]);
  }

  // ===== TOOLBAR =====
  function toolbar(){
    var t = today(), isWeek = u.view === "week" || u.view === "focus";
    var step = isWeek ? 7 : 1, label, isNow;
    if(isWeek){
      var m = monday(u.date), e = addDays(m, 6);
      label = short(m) + " – " + short(e) + (m.slice(0, 4) !== t.slice(0, 4) ? " " + m.slice(0, 4) : "");
      isNow = m === monday(t);
    }else{ label = dayLabel(u.date); isNow = u.date === t; }
    var nav = u.view === "settings" ? h("div") : h("div", { class:"pl-navrow" }, [
      h("button", { type:"button", class:"pl-nav", "aria-label":isWeek ? "previous week" : "previous day", text:"‹",
        onclick:function(){ u.date = addDays(u.date, -step); draw(); } }),
      h("span", { class:"pl-navlabel" + (isNow ? " now" : ""), text:label }),
      h("button", { type:"button", class:"pl-nav", "aria-label":isWeek ? "next week" : "next day", text:"›",
        onclick:function(){ u.date = addDays(u.date, step); draw(); } }),
      isNow ? null : h("button", { type:"button", class:"pl-link", text:isWeek ? "this week" : "today",
        onclick:function(){ u.date = t; draw(); } })
    ]);
    return h("div", null, [
      h("div", { class:"pl-bar" }, [ nav,
        h("button", { type:"button", class:"pl-btn pl-primary", text:"+ add", onclick:function(){ openNew({ date:u.date }); } }) ]),
      h("div", { class:"pl-tabs", role:"tablist" }, [["day", "day"], ["week", "week"], ["focus", "focus areas"], ["settings", "settings"]].map(function(v){
        return h("button", { type:"button", role:"tab", class:"pl-tab" + (u.view === v[0] ? " on" : ""), "aria-selected":u.view === v[0] ? "true" : "false",
          text:v[1], onclick:function(){ u.view = v[0]; u.tplSave = false; u.flash = ""; draw(); } });
      }))
    ]);
  }

  // ===== FORM (add / edit an activity) =====
  function blankDraft(date){
    return { title:"", area:"personal", sub:"", date:date || u.date, start:"", end:"", prio:0, due:"", notes:"",
             repeat:"none", days:[false, false, false, false, false, false, false], scope:"day" };
  }
  function openNew(pre){
    var d = blankDraft(pre.date);
    Object.keys(pre).forEach(function(k){ d[k] = pre[k]; });
    u.form = { key:null, d:d };
    draw(); focusTitle();
  }
  function repeatOf(days){
    if(days.every(Boolean)) return "daily";
    if(days.slice(0, 5).every(Boolean) && !days[5] && !days[6]) return "weekdays";
    return "custom";
  }
  function draftOf(it, date){
    return { title:it.title, area:it.area, sub:it.sub, date:date, start:it.start == null ? "" : hm(it.start),
      end:it.end == null ? "" : hm(it.end), prio:it.prio, due:it.due || "", notes:it.notes || "",
      repeat:"none", days:[false, false, false, false, false, false, false], scope:"day" };
  }
  function openEdit(it){
    var d = draftOf(it, it.date), r = liveRule(it);
    if(r){ d.repeat = repeatOf(r.days); d.days = r.days.slice(); }
    u.form = { key:keyOf(it), d:d };
    draw(); focusTitle();
  }
  function openRule(r){
    var d = draftOf(r, r.from);
    d.repeat = repeatOf(r.days); d.days = r.days.slice(); d.scope = "series";
    u.form = { key:"r:" + r.id, d:d };
    draw(); focusTitle();
  }
  function focusTitle(){ var t = root.querySelector(".pl-ftitle"); if(t){ t.focus(); t.scrollIntoView({ block:"nearest" }); } }
  function repeatDays(d){
    if(d.repeat === "daily") return [true, true, true, true, true, true, true];
    if(d.repeat === "weekdays") return [true, true, true, true, true, false, false];
    if(d.repeat === "weekly"){ var w = [false, false, false, false, false, false, false]; w[wd(d.date)] = true; return w; }
    var c = d.days.slice();
    if(!c.some(Boolean)) c[wd(d.date)] = true;
    return c;
  }
  function form(){
    var F = u.form, d = F.d, ruleMode = !!F.key && F.key.slice(0, 2) === "r:";
    var it = ruleMode ? null : findItem(F.key);
    var rule = ruleMode ? ruleById(F.key.slice(2)) : (it ? liveRule(it) : null);
    var seriesScope = ruleMode || (rule && d.scope === "series");
    var showRepeat = !F.key || (it && !rule) || seriesScope;
    var msg = h("div", { class:"pl-msg", role:"alert" });
    function inp(attrs, key, rerender){
      attrs.class = "pl-in" + (attrs.class ? " " + attrs.class : "");
      attrs.value = d[key];
      attrs[attrs.tag === "select" ? "onchange" : "oninput"] = function(e){
        d[key] = key === "prio" ? +e.target.value : e.target.value;
        if(rerender) draw();
      };
      var tag = attrs.tag || "input"; delete attrs.tag;
      return h(tag, attrs, attrs.kids);
    }
    function sel(key, opts, rerender){
      var s = h("select", { class:"pl-in", onchange:function(e){ d[key] = key === "prio" ? +e.target.value : e.target.value; if(key === "area") d.sub = ""; if(rerender) draw(); } },
        opts.map(function(o){ return h("option", { value:o[0], text:o[1] }); }));
      s.value = String(d[key]);
      return s;
    }
    var title = inp({ type:"text", class:"pl-ftitle", placeholder:"what is it? e.g. SQLi lab, push day, landing page", maxlength:"120" }, "title");
    var subs = SUBS[d.area];
    var grid = h("div", { class:"pl-fgrid" }, [
      h("label", { class:"wide" }, [ "title", title ]),
      h("label", null, [ "focus area", sel("area", AREAS.map(function(a){ return [a, areaName(a)]; }), true) ]),
      subs.length ? h("label", null, [ "type", sel("sub", [["", "—"]].concat(subs.map(function(s){
        return [s, s === "flex" ? "flex time (if work allows)" : s];
      }))) ]) : null,
      h("label", null, [ ruleMode ? "starts" : "date", inp({ type:"date" }, "date") ]),
      h("label", null, [ "start", inp({ type:"time", step:"900" }, "start") ]),
      h("label", null, [ "end", inp({ type:"time", step:"900" }, "end") ]),
      h("label", null, [ "priority", sel("prio", PRIO_NAME.map(function(n, i){ return [String(i), n + (i ? " " + PRIO[i] : "")]; })) ]),
      seriesScope ? null : h("label", null, [ "deadline", inp({ type:"date" }, "due") ]),
      showRepeat ? h("label", null, [ "repeat", sel("repeat", (seriesScope ? [] : [["none", "no"]]).concat([["daily", "every day"], ["weekdays", "weekdays (mon–fri)"],
        ["weekly", "every " + DAYNAME[wd(d.date || today())].toLowerCase()], ["custom", "pick days"]]), true) ]) : null,
      showRepeat && d.repeat === "custom" ? h("div", { class:"pl-days wide" }, DOW.map(function(n, i){
        return h("button", { type:"button", class:"pl-dtog" + (d.days[i] ? " on" : ""), "aria-pressed":d.days[i] ? "true" : "false", text:n,
          onclick:function(){ d.days[i] = !d.days[i]; draw(); } });
      })) : null,
      h("label", { class:"wide" }, [ "notes", inp({ tag:"textarea", rows:"2", placeholder:"topics, links, what done looks like…", maxlength:"2000" }, "notes") ])
    ]);
    if(d.area === "work" && d.sub === "flex") grid.appendChild(h("p", { class:"pl-hint wide", text:"flex time is only a window: it isn't counted as work or as done, and you can plan study or side-hustle blocks inside it. if work gets busy, delete it for that day." }));
    if(d.start === "" && d.end === "") grid.appendChild(h("p", { class:"pl-hint wide", text:"no start and end: it goes in the day's task list instead of the timeline." }));
    var scope = (rule && !ruleMode) ? h("div", { class:"pl-toggle" }, [["day", "this day only"], ["series", "the whole series"]].map(function(s){
      return h("button", { type:"button", class:"pl-tog" + (d.scope === s[0] ? " on" : ""), text:s[1], onclick:function(){ d.scope = s[0]; draw(); } });
    })) : null;
    var head = h("div", { class:"pl-fhead" }, [
      h("h3", { class:"pl-h", text:ruleMode ? "edit repeating activity" : F.key ? "edit activity" : "new activity" }), scope ]);
    var buttons = [
      h("button", { type:"submit", class:"pl-btn pl-primary", text:"save" }),
      h("button", { type:"button", class:"pl-btn pl-ghost", text:"cancel", onclick:function(){ u.form = null; draw(); } })
    ];
    if(F.key){
      var delLabel = ruleMode ? "delete series" : rule ? (d.scope === "series" ? "delete series from here" : "delete this day") : "delete";
      buttons.push(armed(h("button", { type:"button", class:"pl-btn pl-ghost pl-del", text:delLabel }), "confirm?", function(){
        if(ruleMode) deleteRule(rule); else deleteItem(it, d.scope);
        u.form = null; commit();
      }));
    }
    return h("form", { class:"pl-form", onsubmit:function(e){ e.preventDefault(); var err = saveForm(); if(err) msg.textContent = err; },
      onkeydown:function(e){ if(e.key === "Escape"){ e.preventDefault(); u.form = null; draw(); } } },
      [ head, grid, msg, h("div", { class:"pl-frow" }, buttons) ]);
  }
  function saveForm(){
    var F = u.form, d = F.d;
    if(!d.title.trim()) return "give it a title";
    if(!isDate(d.date)) return "pick a date";
    var s = parseHm(d.start), e = parseHm(d.end);
    if((d.start === "") !== (d.end === "")) return "set both start and end, or leave both empty for a task without a time";
    if(d.start !== "" && (s == null || e == null)) return "times look wrong";
    if(d.start !== "" && e <= s) return "end must be after start";
    if(d.due && !isDate(d.due)) return "deadline looks wrong";
    var f = normFields({}, { title:d.title, area:d.area, sub:d.sub, start:s, end:e, prio:d.prio, notes:d.notes, due:d.due });
    var ruleMode = !!F.key && F.key.slice(0, 2) === "r:";
    if(ruleMode){
      var rr = ruleById(F.key.slice(2));
      if(rr){ setFields(rr, f); delete rr.due; rr.days = repeatDays(d); rr.from = d.date; if(rr.until && rr.until < rr.from) delete rr.until; }
    }else if(!F.key){
      if(d.repeat !== "none"){
        var nr = { id:rid() }; setFields(nr, f); delete nr.due;
        nr.days = repeatDays(d); nr.from = d.date; nr.skip = [];
        P.rules.push(nr);
      }else{
        var a = { id:rid(), date:d.date, done:false, createdAt:Date.now() }; setFields(a, f);
        P.acts.push(a);
      }
    }else{
      var it = findItem(F.key), rule = it ? liveRule(it) : null;
      if(!it){ u.form = null; draw(); return ""; }
      if(rule && d.scope === "series"){
        setFields(rule, f); delete rule.due; rule.days = repeatDays(d);
        if(!it.virtual){ setFields(it, f); delete it.due; it.date = d.date; }
      }else if(rule){
        var m = materialize(it); setFields(m, f); m.date = d.date;
      }else{
        setFields(it, f); it.date = d.date;
        if(d.repeat !== "none"){
          var cr = { id:rid() }; setFields(cr, f); delete cr.due;
          cr.days = repeatDays(d); cr.from = d.date; cr.skip = [];
          P.rules.push(cr);
          it.ruleId = cr.id; it.ruleDate = d.date; delete it.due;
        }
      }
    }
    if(u.view === "day" || u.view === "week") u.date = d.date;
    u.form = null; commit();
    return "";
  }
  function deleteItem(it, scope){
    var r = liveRule(it);
    if(r && scope === "series"){
      var from = it.ruleDate, until = addDays(from, -1);
      if(until < r.from) P.rules.splice(P.rules.indexOf(r), 1); else r.until = until;
      P.acts = P.acts.filter(function(a){ return !(a.ruleId === r.id && a.ruleDate >= from && !a.done); });
    }else if(r){
      if(r.skip.indexOf(it.ruleDate) < 0) r.skip.push(it.ruleDate);
      if(!it.virtual) removeAct(it);
    }else removeAct(it);
  }
  // deleting a series keeps ticked days as history
  function deleteRule(r){
    if(!r) return;
    P.rules.splice(P.rules.indexOf(r), 1);
    P.acts = P.acts.filter(function(a){ return !(a.ruleId === r.id && !a.done); });
  }

  // ===== DAY VIEW =====
  function chk(it){
    if(isFlex(it)) return null;
    return h("button", { type:"button", class:"pl-chk" + (it.done ? " on" : ""), "aria-pressed":it.done ? "true" : "false",
      "aria-label":(it.done ? "untick " : "tick ") + it.title, text:it.done ? "✓" : "",
      onclick:function(e){ e.stopPropagation(); toggle(it); }, onpointerdown:function(e){ e.stopPropagation(); } });
  }
  function meta(it){
    var bits = [];
    if(it.sub) bits.push(it.sub === "flex" ? "flex · if work allows" : it.sub);
    if(it.prio) bits.push(PRIO[it.prio]);
    if(it.due) bits.push("due " + short(it.due));
    if(it.ruleId && liveRule(it)) bits.push("↻");
    return bits.join(" · ");
  }
  function layout(blocks){
    // overlapping blocks share the width in lanes; returns { key: { lane, lanes } }
    var out = {}, group = [], end = -1;
    function flush(){
      var ends = [];
      group.forEach(function(it){
        var l = -1;
        for(var i = 0; i < ends.length; i++) if(ends[i] <= it.start){ l = i; break; }
        if(l < 0){ l = ends.length; ends.push(0); }
        ends[l] = it.end; out[keyOf(it)] = { lane:l };
      });
      group.forEach(function(it){ out[keyOf(it)].lanes = ends.length; });
      group = [];
    }
    blocks.slice().sort(function(a, b){ return a.start - b.start || b.end - a.end; }).forEach(function(it){
      if(group.length && it.start >= end) flush();
      group.push(it); end = Math.max(group.length > 1 ? end : -1, it.end);
    });
    if(group.length) flush();
    return out;
  }
  function freeSlots(date, blocks){
    var s = P.settings.dayStart, e = P.settings.dayEnd, out = [];
    if(date === today()) s = Math.max(s, Math.ceil(nowMin() / SNAP) * SNAP);
    if(date < today()) return out;
    var cur = s;
    blocks.slice().sort(function(a, b){ return a.start - b.start; }).forEach(function(b){
      if(b.start > cur && b.start - cur >= 30) out.push({ start:cur, end:Math.min(b.start, e) });
      cur = Math.max(cur, b.end);
    });
    if(e - cur >= 30) out.push({ start:cur, end:e });
    return out.filter(function(x){ return x.end - x.start >= 30; });
  }
  function overdueList(t){
    return P.acts.filter(function(a){
      return !a.done && !isFlex(a) && ((!a.ruleId && a.date < t) || (a.due && a.due < t));
    }).sort(function(a, b){ return a.date < b.date ? -1 : 1; });
  }
  function dayView(){
    var d = u.date, t = today(), items = itemsOn(d);
    var timed = items.filter(function(it){ return it.start != null; });
    var untimed = items.filter(function(it){ return it.start == null; });
    var flex = timed.filter(isFlex), blocks = timed.filter(function(it){ return !isFlex(it); });
    // overlapping blocks share the width; a clash is any overlap except work inside work
    // (a meeting during core work is normal)
    var lanes = layout(blocks), clash = {};
    blocks.forEach(function(a, i){
      blocks.forEach(function(b, j){
        if(j > i && a.start < b.end && b.start < a.end && !(a.area === "work" && b.area === "work")){ clash[keyOf(a)] = 1; clash[keyOf(b)] = 1; }
      });
    });
    var overlaps = blocks.filter(function(it){ return clash[keyOf(it)]; });
    var st = dayStat(d);

    // --- left: task list + timeline ---
    var left = h("div", { class:"pl-dmain" });
    left.appendChild(h("div", { class:"pl-dhead" }, [
      h("h2", { class:"pl-dtitle" + (d === t ? " now" : ""), text:DAYNAME[wd(d)] + " " + +d.slice(8, 10) + " " + MON[+d.slice(5, 7) - 1].toLowerCase() }),
      h("span", { class:"pl-dstat" }, [ st.done + "/" + st.total + " done · " + hrs(st.sched) + " planned" + (st.flex ? " · " + hrs(st.flex) + " flex" : ""),
        linked() ? (counts(d) ? h("b", { class:"pl-streak", text:" · counts for the streak ✓" })
          : st.total ? h("span", { text:" · streak: " + (P.streak.rule === "pct" ? "reach " + P.streak.pct + "%" : "finish everything") }) : null) : null ]),
      h("button", { type:"button", class:"pl-link" + (P.rest[d] ? " on" : ""), text:P.rest[d] ? "rest day ✓" : "mark rest day",
        onclick:function(){ if(P.rest[d]) delete P.rest[d]; else P.rest[d] = true; commit(); } })
    ]));
    // tasks without a time
    var qa = h("input", { type:"text", class:"pl-in pl-qadd", placeholder:"add a task (no time) and press enter", maxlength:"120",
      onkeydown:function(e){
        if(e.key !== "Enter" || !e.target.value.trim()) return;
        e.preventDefault();
        var a = { id:rid(), date:d, done:false, createdAt:Date.now() };
        setFields(a, normFields({}, { title:e.target.value, area:u.qarea }));
        P.acts.push(a); commit();
        var n = root.querySelector(".pl-qadd"); if(n) n.focus();
      } });
    var qsel = h("select", { class:"pl-in pl-qarea", "aria-label":"focus area for new tasks", onchange:function(e){ u.qarea = e.target.value; } },
      AREAS.map(function(a){ return h("option", { value:a, text:areaName(a) }); }));
    qsel.value = u.qarea;
    left.appendChild(h("div", { class:"pl-tasks" }, untimed.map(taskRow).concat([ h("div", { class:"pl-qrow" }, [ qa, qsel ]) ])));

    // timeline
    var s0 = P.settings.dayStart, e0 = P.settings.dayEnd;
    timed.forEach(function(it){ s0 = Math.min(s0, Math.floor(it.start / 60) * 60); e0 = Math.max(e0, Math.ceil(it.end / 60) * 60); });
    var grid = h("div", { class:"pl-grid", style:"height:" + Math.round((e0 - s0) * PX) + "px" });
    for(var m = s0; m <= e0; m += 60){
      grid.appendChild(h("div", { class:"pl-hour", style:"top:" + Math.round((m - s0) * PX) + "px" }, [ h("span", { text:hm(m % 1440) }) ]));
    }
    grid.addEventListener("click", function(e){
      if(e.target !== grid && !e.target.classList.contains("pl-hour")) return;
      var y = e.clientY - grid.getBoundingClientRect().top;
      var at = s0 + Math.floor(y / PX / 30) * 30;
      openNew({ date:d, start:hm(at), end:hm(Math.min(at + 60, 1440 - 1)) });
    });
    flex.forEach(function(it){
      // clicking inside flex time plans something there; its label edits the window itself
      var band = h("div", { class:"pl-flex", style:"top:" + Math.round((it.start - s0) * PX) + "px;height:" + Math.max(10, Math.round(mins(it) * PX) - 2) + "px",
        title:"flex time " + hm(it.start) + "–" + hm(it.end) + ": open if work allows. click to plan something here",
        onclick:function(e){
          e.stopPropagation();
          var y = e.clientY - grid.getBoundingClientRect().top, at = Math.max(it.start, s0 + Math.floor(y / PX / 15) * 15);
          openNew({ date:d, start:hm(at), end:hm(Math.min(it.end, at + 60)) });
        } },
        [ h("button", { type:"button", class:"pl-flab", text:"flex " + hm(it.start) + "–" + hm(it.end) + " · if work allows",
            onclick:function(e){ e.stopPropagation(); openEdit(it); } }) ]);
      grid.appendChild(band);
    });
    blocks.forEach(function(it){ grid.appendChild(block(it, lanes[keyOf(it)], s0, !!clash[keyOf(it)])); });
    if(d === t){
      var nm = nowMin();
      if(nm >= s0 && nm <= e0) grid.appendChild(h("div", { class:"pl-nowline", style:"top:" + Math.round((nm - s0) * PX) + "px" }));
    }
    left.appendChild(h("div", { class:"pl-gridwrap" }, [ grid ]));
    left.appendChild(h("p", { class:"pl-hint" }, [ h("span", { class:"pl-mouse", text:"click empty time to add · drag a block to move it, its bottom edge to resize" }),
      h("span", { class:"pl-touch", text:"tap empty time to add · drag ≡ to move, the bottom edge to resize" }) ]));

    // --- right: warnings, free time, overdue, reflection ---
    var side = h("div", { class:"pl-dside" });
    var warns = [];
    if(st.sched > P.settings.maxHours * 60) warns.push(hrs(st.sched) + " planned: more than your " + P.settings.maxHours + "h limit. leave room to recover.");
    if(st.total > 14) warns.push(st.total + " activities in one day is a lot. what can move?");
    overlaps.forEach(function(it){ warns.push("overlap: " + hm(it.start) + "–" + hm(it.end) + " " + it.title); });
    if(warns.length) side.appendChild(section("heads up", [ h("ul", { class:"pl-warn" }, warns.map(function(w){ return h("li", { text:w }); })) ]));

    var fs = freeSlots(d, blocks);
    if(fs.length || flex.length){
      var rows = fs.map(function(x){
        var inFlex = 0;
        flex.forEach(function(f){ inFlex += Math.max(0, Math.min(f.end, x.end) - Math.max(f.start, x.start)); });
        return h("button", { type:"button", class:"pl-slot", title:"plan something here",
          onclick:function(){ openNew({ date:d, start:hm(x.start), end:hm(Math.min(x.end, x.start + 60)) }); } },
          [ h("span", { text:hm(x.start) + "–" + hm(x.end) }), h("small", { text:hrs(x.end - x.start) + (inFlex ? " · " + (inFlex >= x.end - x.start ? "flex" : "part flex") + ", if work allows" : "") }) ]);
      });
      flex.forEach(function(f){
        var used = 0;
        blocks.forEach(function(b){ if(b.area !== "work") used += Math.max(0, Math.min(f.end, b.end) - Math.max(f.start, b.start)); });
        rows.push(h("div", { class:"pl-flexuse" }, [ h("span", { text:"flex " + hm(f.start) + "–" + hm(f.end) }),
          h("small", { text:used ? hrs(used) + " used for study / side hustle" : "not used yet" }) ]));
      });
      side.appendChild(section("free time", rows));
    }

    if(d === t){
      var od = overdueList(t);
      if(od.length){
        side.appendChild(section("overdue", od.slice(0, 8).map(function(a){
          return h("div", { class:"pl-odrow a-" + a.area }, [ chk(a),
            h("button", { type:"button", class:"pl-odt", text:a.title, onclick:function(){ u.date = a.date; openEdit(a); } }),
            h("small", { text:a.due && a.due < t ? "due " + short(a.due) : short(a.date) }),
            h("button", { type:"button", class:"pl-act", title:"move to today", text:"→ today", onclick:function(){ a.date = t; commit(); } }) ]);
        }).concat(od.length > 8 ? [ h("p", { class:"pl-hint", text:"+" + (od.length - 8) + " more" }) ] : []),
        armed(h("button", { type:"button", class:"pl-link", text:"move all " + od.length + " to today" }), "confirm: move " + od.length + "?", function(){
          od.forEach(function(a){ if(a.date < t) a.date = t; }); commit();
        })));
      }
    }
    var dl = P.acts.filter(function(a){ return !a.done && a.due && a.due >= t && a.due <= addDays(t, 7); })
      .sort(function(a, b){ return a.due < b.due ? -1 : 1; });
    if(dl.length && d >= t) side.appendChild(section("deadlines this week", dl.map(function(a){
      return h("button", { type:"button", class:"pl-dlrow", onclick:function(){ u.date = a.date; openEdit(a); } },
        [ h("i", { class:"pl-sw a-" + a.area }), h("span", { text:a.title }), h("small", { text:a.due === t ? "today" : dayLabel(a.due) }) ]);
    })));

    var unfinished = items.filter(function(it){ return !it.virtual && !it.ruleId && !it.done && !isFlex(it); });
    if(unfinished.length && d <= t){
      var nd = addDays(d, 1);
      side.appendChild(h("div", { class:"pl-sec" }, [ armed(h("button", { type:"button", class:"pl-btn", text:"carry " + unfinished.length + " unfinished → " + DOW[wd(nd)].toLowerCase() }),
        "confirm: move " + unfinished.length + "?", function(){ unfinished.forEach(function(a){ a.date = nd; }); commit(); }) ]));
    }
    side.appendChild(templateRow("day", d));
    side.appendChild(textBox("daily reflection", P.reflect, d, REFLECT));

    body.appendChild(h("div", { class:"pl-day" }, [ left, side ]));
  }
  function taskRow(it){
    return h("div", { class:"pl-task a-" + it.area + (it.done ? " done" : ""), onclick:function(){ openEdit(it); } }, [
      chk(it), h("span", { class:"pl-ttitle", text:it.title }),
      h("small", { text:[areaName(it.area), meta(it)].filter(Boolean).join(" · ") })
    ]);
  }
  var justDragged = false;
  function block(it, ln, s0, isClash){
    var top = Math.round((it.start - s0) * PX), ht = Math.max(12, Math.round(mins(it) * PX) - 2);
    var el = h("div", { class:"pl-blk a-" + it.area + (it.done ? " done" : "") + (isClash ? " over" : "") + (ht < 30 ? " tiny" : ""),
      style:"top:" + top + "px;height:" + ht + "px;--l:" + ln.lane + ";--n:" + ln.lanes,
      tabindex:"0", role:"button", "aria-label":hm(it.start) + " to " + hm(it.end) + " " + it.title + (it.done ? ", done" : ""),
      onclick:function(){ if(justDragged) return; openEdit(it); },
      onkeydown:function(e){ if(e.key === "Enter"){ e.preventDefault(); openEdit(it); } } }, [
      chk(it),
      h("span", { class:"pl-btime", text:hm(it.start) + "–" + hm(it.end) }),
      h("span", { class:"pl-btitle", text:it.title }),
      h("span", { class:"pl-bmeta", text:[areaName(it.area), meta(it)].filter(Boolean).join(" · ") + (isClash ? " · overlap" : "") }),
      h("span", { class:"pl-grip", "aria-hidden":"true", text:"≡" }),
      h("span", { class:"pl-rs", "aria-hidden":"true" })
    ]);
    el.addEventListener("pointerdown", function(e){
      if(e.button !== 0) return;
      var resize = e.target.classList.contains("pl-rs");
      if(!resize && e.pointerType !== "mouse" && !e.target.classList.contains("pl-grip")) return;
      e.preventDefault();
      var y0 = e.clientY, s = it.start, en = it.end, len = en - s, ns = s, ne = en, moved = false;
      var timeEl = el.querySelector(".pl-btime");
      el.setPointerCapture(e.pointerId);
      function mv(ev){
        if(!moved && Math.abs(ev.clientY - y0) < 4) return;
        moved = true; el.classList.add("drag");
        var dm = Math.round((ev.clientY - y0) / PX / SNAP) * SNAP;
        if(resize){ ns = s; ne = Math.min(1440, Math.max(s + SNAP, en + dm)); }
        else{ ns = Math.min(1440 - len, Math.max(0, s + dm)); ne = ns + len; }
        el.style.top = Math.round((ns - s0) * PX) + "px";
        el.style.height = Math.max(12, Math.round((ne - ns) * PX) - 2) + "px";
        timeEl.textContent = hm(ns) + "–" + hm(ne);
      }
      function up(){
        el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
        if(!moved) return;
        justDragged = true; setTimeout(function(){ justDragged = false; }, 50);
        if(ns === s && ne === en){ draw(); return; }
        var a = materialize(it); a.start = ns; a.end = ne; commit();
      }
      el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    });
    return el;
  }

  // ----- templates (day and week) -----
  function blocksOf(list){ return list.map(function(it){ var f = {}; setFields(f, it); delete f.due; return f; }); }
  function applyBlocks(date, blocks){
    var have = itemsOn(date), n = 0;
    blocks.forEach(function(b){
      if(have.some(function(x){ return x.title === b.title && x.start === b.start; })) return;
      var a = { id:rid(), date:date, done:false, createdAt:Date.now() }; setFields(a, b);
      P.acts.push(a); n++;
    });
    return n;
  }
  function templateRow(kind, date){
    var list = P.templates.filter(function(t){ return t.kind === kind; });
    var mon = monday(date);
    var kids = [];
    if(u.tplSave){
      var name = h("input", { type:"text", class:"pl-in", placeholder:"template name, e.g. office day", maxlength:"40",
        onkeydown:function(e){ if(e.key === "Enter"){ e.preventDefault(); saveTpl(); } if(e.key === "Escape"){ u.tplSave = false; draw(); } } });
      var saveTpl = function(){
        if(!name.value.trim()){ name.focus(); return; }
        var days = kind === "day" ? [blocksOf(itemsOn(date))] : [0, 1, 2, 3, 4, 5, 6].map(function(k){ return blocksOf(itemsOn(addDays(mon, k))); });
        P.templates.push({ id:rid(), name:name.value.trim().slice(0, 40), kind:kind, days:days });
        u.tplSave = false; u.flash = "saved template “" + name.value.trim() + "”"; commit();
      };
      kids.push(h("div", { class:"pl-qrow" }, [ name,
        h("button", { type:"button", class:"pl-btn", text:"save", onclick:saveTpl }),
        h("button", { type:"button", class:"pl-btn pl-ghost", text:"×", "aria-label":"cancel", onclick:function(){ u.tplSave = false; draw(); } }) ]));
      setTimeout(function(){ name.focus(); }, 0);
    }else{
      var row = [];
      if(list.length){
        var s = h("select", { class:"pl-in", "aria-label":"apply a template", onchange:function(e){
          var tp = null; list.forEach(function(t){ if(t.id === e.target.value) tp = t; });
          if(!tp) return;
          var n = 0;
          if(kind === "day") n = applyBlocks(date, tp.days[0]);
          else tp.days.forEach(function(b, k){ n += applyBlocks(addDays(mon, k), b); });
          u.flash = "added " + n + " from “" + tp.name + "”"; commit();
        } }, [ h("option", { value:"", text:"apply a " + kind + " template…" }) ].concat(list.map(function(t){ return h("option", { value:t.id, text:t.name }); })));
        row.push(s);
      }
      row.push(h("button", { type:"button", class:"pl-btn pl-ghost", text:"save this " + kind + " as template", onclick:function(){ u.tplSave = true; u.flash = ""; draw(); } }));
      kids.push(h("div", { class:"pl-qrow" }, row));
    }
    if(u.flash) kids.push(h("p", { class:"pl-hint", text:u.flash }));
    return section(kind + " templates", kids);
  }
  // reflection / review: optional questions saved as you type
  function textBox(title, store, key, qs){
    var cur = store[key] || {}, filled = qs.filter(function(q){ return cur[q[0]]; }).length;
    var det = h("details", { class:"pl-sec pl-refl" });
    if(filled) det.open = true;
    det.appendChild(h("summary", { class:"pl-h", text:title + (filled ? " · " + filled + "/" + qs.length : "") }));
    qs.forEach(function(q){
      det.appendChild(h("label", { class:"pl-rq" }, [ q[1], h("textarea", { class:"pl-in", rows:"2", value:cur[q[0]] || "", maxlength:"4000",
        oninput:function(e){
          var o = store[key] || (store[key] = {});
          if(e.target.value.trim()) o[q[0]] = e.target.value; else delete o[q[0]];
          if(!Object.keys(o).length) delete store[key];
          ctx.save();
        } }) ]));
    });
    return det;
  }

  // ===== WEEK VIEW =====
  var dragKey = null;
  function weekView(){
    var mon = monday(u.date), t = today(), w = weekStats(mon);
    var cols = [];
    for(var k = 0; k < 7; k++) cols.push(dayCol(addDays(mon, k), w.days[k], t));
    body.appendChild(h("div", { class:"pl-week" }, cols));
    var prevMon = addDays(mon, -7);
    var copyable = 0;
    for(var j = 0; j < 7; j++) (byDate[addDays(prevMon, j)] || []).forEach(function(a){ if(!a.ruleId) copyable++; });
    var acts = [];
    if(copyable) acts.push(armed(h("button", { type:"button", class:"pl-btn", text:"copy last week (" + copyable + ")" }), "confirm: copy " + copyable + "?", function(){
      var n = 0;
      for(var i = 0; i < 7; i++){
        var from = addDays(prevMon, i);
        n += applyBlocks(addDays(mon, i), blocksOf((byDate[from] || []).filter(function(a){ return !a.ruleId; })));
      }
      u.flash = "copied " + n + " from last week (repeating ones show up on their own)"; commit();
    }));
    body.appendChild(h("div", { class:"pl-wactions" }, acts.concat([ templateRow("week", mon) ])));
    body.appendChild(scorecard(w, mon));
    body.appendChild(textBox("weekly review", P.reviews, mon, REVIEW));
  }
  function dayCol(d, st, t){
    var items = itemsOn(d);
    var col = h("div", { class:"pl-col" + (d === t ? " now" : "") + (d < t ? " past" : "") + (P.rest[d] ? " rest" : ""),
      ondragover:function(e){ if(dragKey){ e.preventDefault(); col.classList.add("dropping"); } },
      ondragleave:function(){ col.classList.remove("dropping"); },
      ondrop:function(e){
        e.preventDefault(); col.classList.remove("dropping");
        var it = findItem(dragKey); dragKey = null;
        if(!it || it.date === d) return;
        var a = materialize(it); a.date = d; commit();
      } }, [
      h("button", { type:"button", class:"pl-colhead", title:"open this day", onclick:function(){ u.view = "day"; u.date = d; draw(); } }, [
        h("b", { text:DOW[wd(d)] + " " + +d.slice(8, 10) }),
        h("small", null, [ st.total ? st.done + "/" + st.total + " · " + hrs(st.sched) : (P.rest[d] ? "rest" : "free"),
          counts(d) ? h("b", { class:"pl-streak", title:"counts for the streak", text:" ✓" }) : null ])
      ]),
      st.total ? pbar(st.done / st.total) : null
    ]);
    if(P.rest[d]) col.appendChild(h("div", { class:"pl-restlab", text:"rest day" }));
    items.forEach(function(it){
      var row = h("div", { class:"pl-wi a-" + it.area + (it.done ? " done" : "") + (isFlex(it) ? " flex" : ""), draggable:"true",
        title:(it.start != null ? hm(it.start) + "–" + hm(it.end) + " " : "") + it.title + (meta(it) ? " · " + meta(it) : ""),
        onclick:function(){ openEdit(it); },
        ondragstart:function(e){ dragKey = keyOf(it); e.dataTransfer.effectAllowed = "move"; try{ e.dataTransfer.setData("text/plain", it.title); }catch(err){} },
        ondragend:function(){ dragKey = null; } }, [
        chk(it),
        h("span", { class:"pl-wtime", text:it.start != null ? hm(it.start) : "task" }),
        h("span", { class:"pl-wtitle", text:isFlex(it) ? "flex time" : it.title })
      ]);
      col.appendChild(row);
    });
    col.appendChild(h("button", { type:"button", class:"pl-wadd", "aria-label":"add to " + dayLabel(d), text:"+", onclick:function(){ openNew({ date:d }); } }));
    return col;
  }
  function scorecard(w, mon){
    var names = { work:"work hours", gym:"gym sessions", cwes:"study hours", side:"side-hustle hours" };
    var rows = FOCUS.map(function(a){
      var A = P.areas[a], act = actual(w, a), sch = scheduled(w, a);
      var label = A.name + " " + (A.unit === "sessions" ? "sessions" : "hours");
      if(a === "work" && A.name === "work") label = names.work;
      var pct = A.target ? Math.round(act / A.target * 100) : null;
      return h("tr", { class:"a-" + a }, [
        h("td", null, [ h("i", { class:"pl-sw a-" + a }), label ]),
        h("td", { class:"num", text:A.target ? fmtVal(a, A.target) : "—" }),
        h("td", { class:"num", text:fmtVal(a, sch) }),
        h("td", { class:"num" }, [ h("b", { text:fmtVal(a, act) }) ]),
        h("td", { class:"num" + (pct != null && pct < 50 && mon < monday(today()) ? " pl-red" : ""), text:pct == null ? "—" : pct + "%" })
      ]);
    });
    return section("weekly scorecard", [
      h("div", { class:"pl-twrap" }, [ h("table", { class:"pl-table" }, [
        h("thead", null, [ h("tr", null, ["metric", "target", "scheduled", "actual", "vs target"].map(function(c, i){ return h("th", { class:i ? "num" : "", text:c }); })) ]),
        h("tbody", null, rows)
      ]) ]),
      h("p", { class:"pl-hint", text:"actual counts only what you ticked: hours from finished timed blocks, gym as days with a finished session. filling the calendar earns nothing." })
    ]);
  }

  // ===== FOCUS AREAS =====
  function focusView(){
    var mon = monday(u.date), w = weekStats(mon), t = today();
    var subLabels = { work:"by type", gym:"by type", cwes:"study by type", side:"time by type" };
    body.appendChild(h("div", { class:"pl-focus" }, FOCUS.map(function(a){
      var A = P.areas[a], W = w.area[a], act = actual(w, a);
      var list = [];
      for(var k = 0; k < 7; k++) itemsOn(addDays(mon, k)).forEach(function(it){ if(it.area === a && !isFlex(it)) list.push(it); });
      var kids = [
        h("div", { class:"pl-fprog" }, [ h("b", { text:fmtVal(a, act) + (A.target ? " / " + fmtVal(a, A.target) : "") }),
          h("small", { text:(A.unit === "sessions" ? " sessions" : "") + " done · " + fmtVal(a, scheduled(w, a)) + " scheduled" }) ]),
        pbar(A.target ? act / A.target : 0, a)
      ];
      var subs = SUBS[a].filter(function(s){ return s !== "flex"; });
      if(a === "gym"){
        var dd = Object.keys(W.doneDays).sort();
        kids.push(h("p", { class:"pl-fline", text:dd.length ? "trained: " + dd.map(function(x){ return DOW[wd(x)].toLowerCase(); }).join(" · ") : "no sessions ticked this week" }));
      }else if(subs.length && W.done){
        kids.push(h("p", { class:"pl-fline", text:subLabels[a] + ": " + subs.concat(["other"]).filter(function(s){ return W.subs[s]; }).map(function(s){ return s + " " + hrs(W.subs[s]); }).join(" · ") }));
      }
      if(a === "side" && W.done){
        var money = 0; MONEY_SUBS.forEach(function(s){ money += W.subs[s] || 0; });
        kids.push(h("p", { class:"pl-fline" + (money ? "" : " pl-red"), text:"money-facing (marketing + monetize): " + hrs(money) + " of " + hrs(W.done) +
          (money ? "" : ". building is good, but someone has to pay.") }));
      }
      kids.push(h("div", { class:"pl-flist" }, list.length ? list.map(function(it){
        return h("div", { class:"pl-task a-" + a + (it.done ? " done" : ""), onclick:function(){ u.view = "day"; u.date = it.date; openEdit(it); } }, [
          chk(it), h("span", { class:"pl-ttitle", text:it.title }),
          h("small", { text:DOW[wd(it.date)].toLowerCase() + (it.start != null ? " " + hm(it.start) + " · " + hrs(mins(it)) : "") + (it.sub ? " · " + it.sub : "") })
        ]);
      }) : [ h("p", { class:"pl-hint", text:"nothing planned this week" }) ]));
      // open tasks without a time from other weeks: an idea list / backlog
      var back = P.acts.filter(function(x){ return x.area === a && !x.done && x.start == null && !x.ruleId && (x.date < mon || x.date > addDays(mon, 6)); });
      if(back.length) kids.push(h("p", { class:"pl-fline", text:"open elsewhere: " + back.slice(0, 5).map(function(x){ return x.title; }).join(" · ") + (back.length > 5 ? " +" + (back.length - 5) : "") }));
      kids.push(h("button", { type:"button", class:"pl-link", text:"+ add " + A.name, onclick:function(){
        var dd = mon <= t && t <= addDays(mon, 6) ? t : mon;
        openNew({ date:dd, area:a });
      } }));
      return h("section", { class:"pl-fcard a-" + a }, [ h("div", { class:"pl-shead" }, [ h("h3", { class:"pl-h" }, [ h("i", { class:"pl-sw a-" + a }), A.name ]) ]) ].concat(kids));
    })));
  }

  // ===== SETTINGS =====
  function settingsView(){
    // linked streak page
    var trackers = ctx.trackers ? ctx.trackers() : [];
    var tsel = h("select", { class:"pl-in", "aria-label":"linked streak page", onchange:function(e){ P.streak.page = e.target.value; commit(); } },
      [ h("option", { value:"", text:"none" }) ].concat(trackers.map(function(t){ return h("option", { value:t.id, text:t.title || "untitled" }); })));
    tsel.value = trackers.some(function(t){ return t.id === P.streak.page; }) ? P.streak.page : "";
    var rsel = h("select", { class:"pl-in", "aria-label":"when a day counts", onchange:function(e){ P.streak.rule = e.target.value; commit(); } },
      [ h("option", { value:"all", text:"everything planned is done" }), h("option", { value:"pct", text:"a share of it is done" }) ]);
    rsel.value = P.streak.rule;
    var L = linked();
    body.appendChild(section("streak", [ h("div", { class:"pl-srow" }, [
      h("label", null, [ "linked streak page", tsel ]),
      h("label", null, [ "a day counts when", rsel ]),
      P.streak.rule === "pct" ? h("label", null, [ "share done (%)", h("input", { class:"pl-in pl-num", type:"number", min:"10", max:"100", step:"5", value:String(P.streak.pct),
        onchange:function(e){ var v = Math.round(+e.target.value); if(v >= 10 && v <= 100) P.streak.pct = v; commit(); } }) ]) : null
    ]), h("p", { class:"pl-hint", text:L ? "a day that counts ticks its box on “" + L.title + "” (streak " + L.cur + ", best " + L.best + "). flex time doesn't count, and unticking here never unticks a box." :
      "pick one of your day trackers: each day you finish what you planned ticks that day's box, so the streak keeps itself. a tracker without a start date starts today." }) ]));

    // focus areas and weekly targets
    body.appendChild(section("focus areas and weekly targets", [ h("div", { class:"pl-arows" }, FOCUS.map(function(a){
      var A = P.areas[a];
      var unit = h("select", { class:"pl-in", "aria-label":A.name + " target unit", onchange:function(e){ A.unit = e.target.value; commit(); } },
        [ h("option", { value:"h", text:"hours / week" }), h("option", { value:"sessions", text:"sessions / week" }) ]);
      unit.value = A.unit;
      return h("div", { class:"pl-arow" }, [ h("i", { class:"pl-sw a-" + a }),
        h("input", { class:"pl-in", type:"text", value:A.name, maxlength:"30", "aria-label":"name",
          onchange:function(e){ A.name = e.target.value.trim().slice(0, 30) || AREA_DEF[a].name; commit(); } }),
        h("input", { class:"pl-in pl-num", type:"number", min:"0", max:"200", step:A.unit === "h" ? "0.5" : "1", value:String(A.target), "aria-label":"weekly target",
          onchange:function(e){ var v = +e.target.value; A.target = isFinite(v) && v >= 0 && v <= 200 ? Math.round(v * 10) / 10 : A.target; commit(); } }),
        unit ]);
    })), h("p", { class:"pl-hint", text:"0 means no target (work's planned hours then come from the calendar)." }) ]));

    // day range and overload warning
    var hours = []; for(var i = 0; i <= 24; i++) hours.push(i * 60);
    function hourSel(key, label){
      var s = h("select", { class:"pl-in", "aria-label":label, onchange:function(e){
        var v = +e.target.value, o = P.settings;
        if(key === "dayStart" && v < o.dayEnd) o.dayStart = v;
        if(key === "dayEnd" && v > o.dayStart) o.dayEnd = v;
        commit();
      } }, hours.map(function(m){ return h("option", { value:String(m), text:hm(m) }); }));
      s.value = String(P.settings[key]);
      return h("label", null, [ label, s ]);
    }
    body.appendChild(section("day", [ h("div", { class:"pl-srow" }, [
      hourSel("dayStart", "timeline starts"), hourSel("dayEnd", "timeline ends"),
      h("label", null, [ "warn above (hours planned)", h("input", { class:"pl-in pl-num", type:"number", min:"1", max:"24", step:"1", value:String(P.settings.maxHours),
        onchange:function(e){ var v = Math.round(+e.target.value); if(v >= 1 && v <= 24){ P.settings.maxHours = v; } commit(); } }) ])
    ]) ]));

    // repeating activities
    var rules = P.rules.slice().sort(function(a, b){ return (a.start == null ? -1 : a.start) - (b.start == null ? -1 : b.start); });
    var starter = armed(h("button", { type:"button", class:"pl-btn", text:"add the example 9–5 week" }), "confirm: add it?", addStarter);
    body.appendChild(section("repeating activities", (rules.length ? rules.map(function(r){
      var days = repeatOf(r.days) === "daily" ? "every day" : repeatOf(r.days) === "weekdays" ? "mon–fri" : DOW.filter(function(n, i){ return r.days[i]; }).join(" ").toLowerCase();
      return h("div", { class:"pl-rrow a-" + r.area }, [ h("i", { class:"pl-sw a-" + r.area }),
        h("span", { class:"pl-rtitle", text:r.title + (r.sub ? " · " + r.sub : "") }),
        h("small", { text:days + (r.start != null ? " · " + hm(r.start) + "–" + hm(r.end) : " · task") + (r.until ? " · until " + short(r.until) : "") }),
        h("button", { type:"button", class:"pl-act", text:"edit", onclick:function(){ openRule(r); } }),
        armed(h("button", { type:"button", class:"pl-act", text:"delete" }), "confirm?", function(){ deleteRule(r); commit(); })
      ]);
    }) : [ h("p", { class:"pl-hint", text:"nothing repeats yet. add an activity with “repeat”, or start from the example work week: core work 9–11 and 15–17, flex time 11–12:30 and 13:30–15, lunch 12:30–13:30, mon–fri. change any of it later." }) ])
      .concat([ starter ])));

    // templates
    body.appendChild(section("templates", P.templates.length ? P.templates.map(function(tp){
      var n = 0; tp.days.forEach(function(d){ n += d.length; });
      return h("div", { class:"pl-rrow" }, [
        h("input", { class:"pl-in", type:"text", value:tp.name, maxlength:"40", "aria-label":"template name",
          onchange:function(e){ tp.name = e.target.value.trim().slice(0, 40) || tp.name; commit(); } }),
        h("small", { text:tp.kind + " · " + n + " activities" }),
        armed(h("button", { type:"button", class:"pl-act", text:"delete" }), "confirm?", function(){ P.templates.splice(P.templates.indexOf(tp), 1); commit(); })
      ]);
    }) : [ h("p", { class:"pl-hint", text:"save a day or a week as a template from the day or week view, then apply it anywhere." }) ]));
  }
  function addStarter(){
    var wk = [true, true, true, true, true, false, false], from = monday(today());
    [["core work", "work", "core", 540, 660], ["flexible time", "work", "flex", 660, 750], ["lunch", "personal", "", 750, 810],
     ["flexible time", "work", "flex", 810, 900], ["core work", "work", "core", 900, 1020]].forEach(function(x){
      if(P.rules.some(function(r){ return r.title === x[0] && r.start === x[3]; })) return;
      var r = { id:rid() };
      setFields(r, normFields({}, { title:x[0], area:x[1], sub:x[2], start:x[3], end:x[4] })); delete r.due;
      r.days = wk.slice(); r.from = from; r.skip = [];
      P.rules.push(r);
    });
    commit();
  }

  draw();
}

// ---------- styles ----------
var css = `
.pl{margin-top:.5rem;}
.pl .a-work{--ac:#8a8a8a;} .pl .a-gym{--ac:#e5484b;} .pl .a-cwes{--ac:#4f8fe8;} .pl .a-side{--ac:#cc6f16;} .pl .a-personal{--ac:#5e5e5e;}
.pl-sec{margin-bottom:1.4rem; min-width:0;}
.pl-shead{display:flex; justify-content:space-between; align-items:baseline; gap:1rem; margin-bottom:.55rem;}
.pl-h{display:flex; align-items:center; gap:.4rem; margin:0; font-size:.64rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted);}
.pl-hint{margin:.4rem 0 0; font-size:.66rem; color:var(--muted); letter-spacing:.03em; line-height:1.55;}
.pl-red{color:var(--accent) !important;}
.pl-sw{display:inline-block; width:9px; height:9px; flex:0 0 9px; background:var(--ac);}
.pl-lmuted{color:var(--muted);}
/* dashboard */
.pl-dash{border:2px solid var(--line); padding:.8rem; margin-bottom:1.1rem;}
.pl-tiles{display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:.5rem;}
.pl-tile{border:2px solid var(--line); padding:.6rem .7rem; min-width:0;}
.pl-tlabel{display:flex; align-items:center; gap:.35rem; font-size:.56rem; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); white-space:nowrap; overflow:hidden;}
.pl-tval{font-size:1.1rem; font-weight:700; margin:.25rem 0 .35rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-variant-numeric:tabular-nums;}
.pl-tsub{margin-top:.3rem; font-size:.58rem; letter-spacing:.05em; color:var(--muted); line-height:1.45;}
.pl-pbar{display:block; height:10px; border:2px solid var(--line); position:relative;}
.pl-pbar i{position:absolute; left:0; top:0; bottom:0; background:var(--ac, var(--fg));}
.pl-strip{display:flex; gap:2px; height:22px; align-items:stretch;}
.pl-sday{flex:1 1 0; border:2px solid var(--line); position:relative;}
.pl-sday.now{border-color:var(--fg);}
.pl-sday i{position:absolute; left:0; right:0; bottom:0; background:var(--fg);}
.pl-dist{margin-top:.7rem;}
.pl-distbar{display:flex; gap:2px; height:12px;}
.pl-distbar i{display:block; flex:1 1 0; min-width:3px; background:var(--ac);}
.pl-legend{display:flex; flex-wrap:wrap; gap:.3rem 1rem; margin-top:.45rem; font-size:.6rem; letter-spacing:.06em;}
.pl-legend span{display:inline-flex; align-items:center; gap:.35rem;}
.pl-legend small{color:var(--muted); font-size:inherit;}
.pl-legend .pl-lmuted{margin-left:auto;}
.pl-next{display:flex; flex-wrap:wrap; align-items:center; gap:.4rem .9rem; margin-top:.6rem; font-size:.7rem;}
.pl-nextit{display:inline-flex; align-items:center; gap:.4rem; background:transparent; border:none; color:var(--fg); font:inherit; padding:0; cursor:pointer;}
.pl-nextit:hover{color:var(--accent);}
/* toolbar */
.pl-bar{display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:.8rem;}
.pl-navrow{display:flex; align-items:center; gap:.6rem;}
.pl-navlabel{font-size:1rem; font-weight:700; letter-spacing:.1em; text-transform:uppercase; min-width:10.5rem; text-align:center;}
.pl-navlabel.now{color:var(--accent);}
.pl-nav{background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; width:2rem; height:2rem; cursor:pointer; line-height:1;}
.pl-nav:hover{border-color:var(--fg);}
.pl-link{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.64rem; letter-spacing:.12em; text-transform:uppercase; cursor:pointer; padding:0; text-align:left;}
.pl-link:hover, .pl-link.on{color:var(--accent);}
.pl-link.armed{color:var(--accent);}
.pl-btn{background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.68rem; letter-spacing:.1em; text-transform:uppercase; padding:.45rem .75rem; cursor:pointer;}
.pl-btn:hover{border-color:var(--fg);}
.pl-btn.pl-primary{border-color:var(--accent); color:var(--accent);}
.pl-btn.pl-primary:hover{background:var(--accent); color:var(--accent-ink);}
.pl-btn.pl-ghost{color:var(--muted);}
.pl-btn.armed{border-color:var(--accent); color:var(--accent);}
.pl-tabs{display:flex; border-bottom:2px solid var(--fg); margin-bottom:1.2rem; overflow-x:auto; scrollbar-width:none;}
.pl-tabs::-webkit-scrollbar{display:none;}
.pl-tab{background:transparent; border:2px solid transparent; border-bottom:none; color:var(--muted); font:inherit; font-size:.68rem; letter-spacing:.12em; text-transform:uppercase; padding:.55rem .85rem; cursor:pointer; white-space:nowrap;}
.pl-tab:hover{color:var(--fg);}
.pl-tab.on{color:var(--accent-ink); background:var(--fg); border-color:var(--fg);}
/* form */
.pl-form{border:2px solid var(--fg); padding:1rem; margin-bottom:1.2rem; box-shadow:6px 6px 0 var(--line);}
.pl-fhead{display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:.8rem;}
.pl-fgrid{display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:.6rem;}
.pl-fgrid label, .pl-srow label{display:flex; flex-direction:column; gap:.3rem; font-size:.56rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); min-width:0;}
.pl-fgrid .wide{grid-column:1 / -1;}
.pl-in{width:100%; background:var(--bg); border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.78rem; padding:.42rem .5rem; outline:none; border-radius:0; color-scheme:dark; letter-spacing:0; text-transform:none; box-sizing:border-box;}
.pl-in:focus{border-color:var(--accent);}
select.pl-in{cursor:pointer;}
textarea.pl-in{resize:vertical; min-height:2.4rem; line-height:1.45;}
.pl-ftitle{font-size:.95rem; font-weight:700;}
.pl-toggle{display:flex;}
.pl-tog{background:transparent; border:2px solid var(--line); color:var(--muted); font:inherit; font-size:.62rem; letter-spacing:.1em; text-transform:uppercase; padding:.32rem .6rem; cursor:pointer;}
.pl-tog + .pl-tog{border-left:none;}
.pl-tog.on{border-color:var(--accent); background:var(--accent); color:var(--accent-ink);}
.pl-days{display:flex; gap:0;}
.pl-dtog{flex:1 1 0; background:transparent; border:2px solid var(--line); color:var(--muted); font:inherit; font-size:.62rem; letter-spacing:.08em; padding:.35rem 0; cursor:pointer;}
.pl-dtog + .pl-dtog{border-left:none;}
.pl-dtog.on{background:var(--fg); color:var(--accent-ink); border-color:var(--fg);}
.pl-msg{min-height:1.1em; margin:.55rem 0 .2rem; font-size:.7rem; color:var(--accent);}
.pl-frow{display:flex; gap:.4rem; flex-wrap:wrap;}
.pl-del{margin-left:auto;}
/* day view */
.pl-day{display:grid; grid-template-columns:minmax(0, 1fr) 17rem; gap:1.4rem; align-items:start;}
.pl-dhead{display:flex; align-items:baseline; gap:.4rem 1rem; flex-wrap:wrap; margin-bottom:.6rem;}
.pl-dtitle{margin:0; font-size:.95rem; letter-spacing:.08em; text-transform:uppercase;}
.pl-dtitle.now::after{content:" · today"; color:var(--accent);}
.pl-dstat{font-size:.64rem; color:var(--muted); letter-spacing:.05em;}
.pl-dhead .pl-link{margin-left:auto;}
.pl-tasks{display:flex; flex-direction:column; gap:.3rem; margin-bottom:.8rem;}
.pl-task{display:flex; align-items:center; gap:.5rem; border:2px solid var(--line); border-left:4px solid var(--ac); padding:.3rem .5rem; font-size:.74rem; cursor:pointer; min-width:0;}
.pl-task:hover{border-color:var(--fg); border-left-color:var(--ac);}
.pl-task small{margin-left:auto; color:var(--muted); font-size:.6rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; flex:0 1 auto;}
.pl-ttitle{overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 1 auto; min-width:0;}
.pl-task.done .pl-ttitle, .pl-blk.done .pl-btitle, .pl-wi.done .pl-wtitle{text-decoration:line-through; color:var(--muted);}
.pl-qrow{display:flex; gap:.3rem; align-items:stretch; flex-wrap:wrap;}
.pl-qrow > .pl-in{flex:1 1 9rem; width:auto;}
.pl-qrow .pl-qarea{flex:0 0 8.5rem;}
.pl-chk{flex:0 0 auto; width:16px; height:16px; padding:0; border:2px solid var(--fg); background:transparent; color:var(--accent-ink); font:inherit; font-size:.62rem; line-height:12px; cursor:pointer; text-align:center;}
.pl-chk.on{background:var(--ac, var(--fg)); border-color:var(--ac, var(--fg));}
.pl-gridwrap{border:2px solid var(--line); padding:.5rem .5rem .5rem 0;}
.pl-grid{position:relative; --g0:3.4rem; --g1:1.2rem; cursor:copy;}
.pl-hour{position:absolute; left:0; right:0; height:0; border-top:2px solid #1c1c1c;}
.pl-hour span{position:absolute; left:.5rem; top:-.45rem; font-size:.56rem; color:var(--muted); background:var(--bg); padding-right:.3rem; pointer-events:none;}
.pl-flex{position:absolute; left:var(--g0); right:0; border:2px dashed #3a3a3a; cursor:pointer;
  background:repeating-linear-gradient(45deg, transparent 0 6px, #1b1b1b 6px 8px); box-sizing:border-box;}
.pl-flab{position:absolute; right:calc(var(--g1) + .4rem); top:.15rem; background:transparent; border:none; padding:0; font:inherit; font-size:.56rem; color:var(--muted); letter-spacing:.08em; text-transform:uppercase; white-space:nowrap; cursor:pointer;}
.pl-flab:hover{color:var(--fg); text-decoration:underline;}
.pl-flex:hover{border-color:var(--muted);}
.pl-blk{position:absolute; box-sizing:border-box; cursor:pointer; overflow:hidden; touch-action:auto; user-select:none;
  left:calc(var(--g0) + (100% - var(--g0) - var(--g1)) * var(--l) / var(--n)); width:calc((100% - var(--g0) - var(--g1)) / var(--n) - 3px);
  background:#161616; border:2px solid var(--line); border-left:4px solid var(--ac); padding:.2rem .4rem .2rem 1.6rem; font-size:.66rem; line-height:1.3;}
.pl-blk:hover, .pl-blk:focus-visible{border-color:var(--fg); border-left-color:var(--ac); outline:none; z-index:3;}
.pl-blk.drag{z-index:5; box-shadow:4px 4px 0 var(--line); opacity:.9;}
.pl-blk.over{border-style:dashed; border-color:var(--accent); border-left:4px solid var(--ac);}
.pl-blk.done{opacity:.55;}
.pl-blk .pl-chk{position:absolute; left:.3rem; top:.25rem; width:13px; height:13px; line-height:9px; font-size:.55rem;}
.pl-btime{color:var(--muted); font-size:.58rem; margin-right:.4rem; font-variant-numeric:tabular-nums;}
.pl-btitle{font-weight:700;}
.pl-bmeta{display:block; color:var(--muted); font-size:.56rem; letter-spacing:.04em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.pl-blk.tiny{padding-top:0; padding-bottom:0; white-space:nowrap;}
.pl-blk.tiny .pl-bmeta{display:none;}
.pl-blk.tiny .pl-chk{top:50%; margin-top:-6px;}
.pl-grip{position:absolute; right:.25rem; top:.1rem; color:var(--muted); font-size:.75rem; cursor:grab; touch-action:none; opacity:0; padding:0 .15rem;}
.pl-blk:hover .pl-grip{opacity:1;}
.pl-rs{position:absolute; left:0; right:0; bottom:-2px; height:7px; cursor:ns-resize; touch-action:none;}
.pl-rs:hover{background:var(--ac);}
.pl-nowline{position:absolute; left:var(--g0); right:0; height:0; border-top:2px solid var(--accent); z-index:4; pointer-events:none;}
.pl-nowline::before{content:""; position:absolute; left:-4px; top:-5px; width:8px; height:8px; background:var(--accent);}
.pl-touch{display:none;}
@media (hover:none){ .pl-mouse{display:none;} .pl-touch{display:inline;} .pl-grip{opacity:1; font-size:1rem; padding:0 .3rem;} }
.pl-dside{min-width:0;}
.pl-warn{margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:.3rem; font-size:.7rem; color:var(--accent);}
.pl-warn li{padding-left:1rem; position:relative; line-height:1.45;}
.pl-warn li::before{content:"!"; position:absolute; left:0; font-weight:700;}
.pl-slot, .pl-flexuse, .pl-dlrow{display:flex; justify-content:space-between; align-items:baseline; gap:.6rem; width:100%; background:transparent; border:none; border-bottom:2px solid var(--line);
  color:var(--fg); font:inherit; font-size:.72rem; padding:.35rem 0; text-align:left; box-sizing:border-box;}
.pl-slot{cursor:pointer;}
.pl-slot:hover span{color:var(--accent);}
.pl-slot small, .pl-flexuse small, .pl-dlrow small{color:var(--muted); font-size:.6rem; text-align:right;}
.pl-flexuse{color:var(--muted);}
.pl-dlrow{cursor:pointer; justify-content:flex-start;}
.pl-dlrow span{flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.pl-odrow{display:flex; align-items:center; gap:.45rem; border-bottom:2px solid var(--line); padding:.3rem 0; font-size:.72rem;}
.pl-odt{flex:1 1 auto; min-width:0; background:transparent; border:none; color:var(--fg); font:inherit; padding:0; text-align:left; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.pl-odrow small{color:var(--accent); font-size:.6rem; white-space:nowrap;}
.pl-odrow + .pl-link, .pl-sec > .pl-link{margin-top:.5rem;}
.pl-act{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.62rem; letter-spacing:.06em; cursor:pointer; padding:.1rem .25rem; white-space:nowrap;}
.pl-act:hover{color:var(--fg);}
.pl-act.armed{color:var(--accent); text-transform:uppercase;}
.pl-refl summary{cursor:pointer; list-style:none; margin-bottom:.5rem;}
.pl-refl summary::-webkit-details-marker{display:none;}
.pl-refl summary::before{content:"+ "; color:var(--muted);}
.pl-refl[open] summary::before{content:"− ";}
.pl-rq{display:flex; flex-direction:column; gap:.25rem; font-size:.64rem; color:var(--muted); margin-bottom:.5rem; letter-spacing:.03em;}
/* week view */
.pl-week{display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); gap:.4rem; margin-bottom:1rem;}
.pl-col{border:2px solid var(--line); padding:.4rem; display:flex; flex-direction:column; gap:.25rem; min-width:0; min-height:9rem;}
.pl-col.now{border-color:var(--accent);}
.pl-col.past{opacity:.75;}
.pl-col.rest{background:repeating-linear-gradient(135deg, transparent 0 8px, #151515 8px 10px);}
.pl-col.dropping{border-color:var(--fg); border-style:dashed;}
.pl-colhead{display:flex; justify-content:space-between; align-items:baseline; gap:.3rem; background:transparent; border:none; color:var(--fg); font:inherit; padding:0 0 .2rem; cursor:pointer; text-align:left;}
.pl-colhead b{font-size:.7rem; letter-spacing:.08em;}
.pl-col.now .pl-colhead b{color:var(--accent);}
.pl-colhead small{font-size:.56rem; color:var(--muted); white-space:nowrap;}
.pl-colhead:hover b{text-decoration:underline;}
.pl-col > .pl-pbar{height:6px; border-width:1px; margin-bottom:.2rem;}
.pl-restlab{font-size:.56rem; letter-spacing:.14em; text-transform:uppercase; color:var(--muted);}
.pl-wi{display:flex; align-items:center; gap:.3rem; border-left:3px solid var(--ac); background:#151515; padding:.22rem .3rem; font-size:.62rem; cursor:pointer; min-width:0;}
.pl-wi:hover{background:#1c1c1c;}
.pl-wi .pl-chk{width:12px; height:12px; line-height:8px; font-size:.5rem;}
.pl-wi.flex{background:repeating-linear-gradient(45deg, transparent 0 5px, #1b1b1b 5px 7px); color:var(--muted);}
.pl-wtime{color:var(--muted); font-size:.56rem; flex:0 0 auto; font-variant-numeric:tabular-nums;}
.pl-wtitle{overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;}
.pl-wadd{margin-top:auto; background:transparent; border:2px dashed var(--line); color:var(--muted); font:inherit; font-size:.8rem; padding:.1rem 0; cursor:pointer;}
.pl-wadd:hover{border-color:var(--fg); color:var(--fg);}
.pl-wactions{display:grid; grid-template-columns:auto 1fr; gap:1rem; align-items:start;}
.pl-wactions > .pl-btn{margin-top:1.2rem;}
.pl-twrap{overflow-x:auto;}
.pl-table{width:100%; border-collapse:collapse; font-size:.74rem;}
.pl-table th{text-align:left; border-bottom:2px solid var(--fg); padding:.4rem .5rem; font-size:.58rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); font-weight:400;}
.pl-table td{border-bottom:2px solid var(--line); padding:.45rem .5rem; white-space:nowrap;}
.pl-table td:first-child{display:flex; align-items:center; gap:.45rem;}
.pl-table .num{text-align:right; font-variant-numeric:tabular-nums;}
/* focus areas */
.pl-focus{display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:.8rem;}
.pl-fcard{border:2px solid var(--line); border-top:4px solid var(--ac); padding:.75rem .8rem; display:flex; flex-direction:column; gap:.45rem; min-width:0;}
.pl-fcard .pl-shead{margin-bottom:0;}
.pl-fprog b{font-size:1.15rem; font-variant-numeric:tabular-nums;}
.pl-fprog small{color:var(--muted); font-size:.62rem;}
.pl-fline{margin:0; font-size:.66rem; color:var(--muted); line-height:1.5;}
.pl-flist{display:flex; flex-direction:column; gap:.25rem; max-height:16rem; overflow-y:auto;}
/* settings */
.pl-arows{display:flex; flex-direction:column; gap:.35rem; max-width:34rem;}
.pl-arow{display:grid; grid-template-columns:auto minmax(0, 1fr) 5.5rem 9.5rem; gap:.4rem; align-items:center;}
.pl-num{text-align:right;}
.pl-srow{display:grid; grid-template-columns:repeat(3, minmax(0, 11rem)); gap:.6rem;}
.pl-rrow{display:flex; align-items:center; gap:.5rem; border-bottom:2px solid var(--line); padding:.3rem 0; font-size:.72rem; max-width:40rem;}
.pl-rrow > .pl-in{flex:1 1 auto; width:auto; padding:.3rem .45rem;}
.pl-rtitle{flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.pl-rrow small{flex:1 1 auto; color:var(--muted); font-size:.6rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.pl-sec > .pl-btn{margin-top:.6rem;}
.pl-streak{color:var(--accent); font-weight:700;}
@media (max-width:1100px){
  .pl-tiles{grid-template-columns:repeat(3, minmax(0, 1fr));}
  .pl-day{grid-template-columns:minmax(0, 1fr);}
  .pl-week{grid-template-columns:repeat(4, minmax(0, 1fr));}
}
@media (max-width:640px){
  .pl-dash{padding:.55rem;}
  .pl-tiles{grid-template-columns:repeat(2, minmax(0, 1fr));}
  .pl-tval{font-size:.95rem;}
  .pl-legend .pl-lmuted{margin-left:0;}
  .pl-fgrid{grid-template-columns:repeat(2, minmax(0, 1fr));}
  .pl-navlabel{min-width:0; font-size:.85rem;}
  .pl-week{grid-template-columns:minmax(0, 1fr);}
  .pl-col{min-height:0;}
  .pl-wi{font-size:.7rem; padding:.35rem .4rem;}
  .pl-focus{grid-template-columns:minmax(0, 1fr);}
  .pl-wactions{grid-template-columns:minmax(0, 1fr);}
  .pl-wactions > .pl-btn{margin-top:0;}
  .pl-arow{grid-template-columns:auto minmax(0, 1fr) 4.5rem; }
  .pl-arow select{grid-column:2 / -1;}
  .pl-srow{grid-template-columns:repeat(2, minmax(0, 1fr));}
  .pl-grid{--g0:2.9rem; --g1:.9rem;}
}
`;
var style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

// index.html opens a planner on a given day from a tracker's Day card
function show(pageId, date){
  var u = uiState[pageId] || (uiState[pageId] = { view:"day", date:today(), form:null, tplSave:false, flash:"", qarea:"personal" });
  u.view = "day"; if(isDate(date)) u.date = date; u.form = null;
}
window.Planner = { normalize:normalize, fresh:fresh, mount:mount, countDays:countDays, daySummary:daySummary, show:show,
  // exposed for tests
  _test:{ addDays:addDays, monday:monday, wd:wd, parseHm:parseHm } };
})();
