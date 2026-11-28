// journal.js: the Journal page type ("journal"), for honest daily reflection.
//
// index.html owns storage, sync, undo and the page shell; this file only knows
// a page's `journal` object:
//   Journal.normalize(j)  validate saved data (loading, importing, sync)
//   Journal.fresh()       an empty journal
//   Journal.hasData(j)    anything worth backing up (the sidebar's reminder)
//   Journal.mount(ctx)    draw the page; ctx = { root, page, save, dayWork(date) }
//
// Deliberately not part of the game: no xp, points, badges or streaks, and a
// missed day is never held against you. Nothing is required: every field is
// optional, a 2-minute check-in is enough. Insights describe what shows up
// together in your own entries and never claim that one thing causes another.
(function(){
"use strict";

// ---------- what is asked ----------
// six 1..5 scales; for stress a high number is the hard end
var SCALES = [
  ["mood", "mood", ["awful", "low", "okay", "good", "great"]],
  ["energy", "energy", ["drained", "low", "okay", "good", "full"]],
  ["clarity", "clarity", ["foggy", "scattered", "okay", "clear", "sharp"]],
  ["motivation", "motivation", ["none", "low", "some", "good", "driven"]],
  ["stress", "stress", ["calm", "light", "some", "high", "overwhelmed"]],
  ["confidence", "confidence", ["shaky", "low", "okay", "steady", "strong"]]
];
var SCALE_KEYS = SCALES.map(function(s){ return s[0]; });
// one-tap tags, so patterns can be counted without reading every entry
var GOT = ["procrastinated", "wasted time", "phone / social media", "made excuses", "distracted", "slept badly",
           "skipped the plan", "overcommitted", "avoided something hard", "stayed up late"];
var HELPED = ["slept well", "exercised", "started early", "planned the night before", "no phone",
              "deep work block", "time outside", "ate well", "talked to someone", "rested"];
var CATS = ["study", "fitness", "money", "mind", "work", "discipline", "other"];
var FEEL_PROMPTS = ["how am I feeling today, honestly?", "what's on my mind right now?", "is something bothering me?",
                    "what has been taking up most of my thoughts?"];
var WEEK_Q = [
  ["looking back", [["wins", "what were my biggest wins this week?"], ["fails", "what didn't go the way I wanted?"],
                    ["learned", "what did I learn?"], ["challenged", "what challenged me the most?"]], "I"],
  ["understanding myself", [["patterns", "what patterns did I notice?"], ["distract", "what kept distracting me, and when?"],
                            ["productive", "what made me productive?"], ["kind", "what would I say to a good friend who had my week?"]], "I"],
  // WOOP (mental contrasting with implementation intentions): wish, outcome, obstacle, plan
  ["next week: wish, outcome, obstacle, plan", [["focus", "wish: what do I most want from next week?"],
                      ["outcome", "outcome: what would be the best result of that, and how would it feel?"],
                      ["obstacle", "obstacle: what in me is most likely to get in the way?"],
                      ["plan", "plan: if that obstacle shows up, then I will…"], ["stop", "one thing to stop doing"]], "R"]
];
var MONTH_Q = [["where", "am I where I expected to be?"], ["progress", "what meaningful progress have I made?"],
  ["neglected", "what goals did I neglect?"], ["toomuch", "what did I spend too much time on?"],
  ["avoiding", "what am I avoiding?"], ["changed", "what has changed about me?"],
  ["proud", "what am I proud of this month?"], ["next", "what do I want next month to look like?"]];
var WEEK_KEYS = []; WEEK_Q.forEach(function(g){ g[1].forEach(function(q){ WEEK_KEYS.push(q[0]); }); });
var MONTH_KEYS = MONTH_Q.map(function(q){ return q[0]; });
// tomorrow as an if-then plan: what, when and where, the likely obstacle, and what I'll do then
var TOM_KEYS = ["first", "when", "obst", "cope", "stop"];
// naming a feeling precisely ("frustrated", not "bad") is part of noticing it
var EMOTIONS = ["calm", "content", "grateful", "hopeful", "proud", "focused", "curious", "tired", "bored", "restless",
                "anxious", "stressed", "overwhelmed", "frustrated", "irritable", "sad", "lonely", "guilty", "ashamed", "numb"];
// how well each part is backed (see "why this works"):
// R a research-based technique, I a design choice inspired by research, X experimental
var EV = { R:"research-based", I:"research-inspired", X:"experimental" };

// ---------- helpers ----------
function rid(p){ return (p || "j") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function str(v, max){ v = String(v == null ? "" : v); return max ? v.slice(0, max) : v; }
function int(v, lo, hi){ v = Math.round(+v); return isFinite(v) ? Math.min(Math.max(v, lo), hi) : lo; }
function pad(n){ return (n < 10 ? "0" : "") + n; }
function isoOf(d){ return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function today(){ return isoOf(new Date()); }
function parseIso(s){ var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function isIso(s){ var d = parseIso(s); return !!d && isoOf(d) === s; }
function addDays(s, k){ var d = parseIso(s) || new Date(); return isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + k)); }
function dayDiff(a, b){ return Math.round((parseIso(b) - parseIso(a)) / 86400000); }
function mondayOf(s){ var d = parseIso(s); return addDays(s, -((d.getDay() + 6) % 7)); }
function isYm(s){ return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s); }
function addMonths(ym, k){ var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + k; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + "-" + pad(m + 1); }
function daysInMonth(ym){ return new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate(); }
function obj(v){ return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
function arr(v){ return Array.isArray(v) ? v : []; }
function lower(s){ return String(s || "").trim().toLowerCase(); }
function uniq(a){ var s = {}; return a.filter(function(x){ var k = lower(x); if(!k || s[k]) return false; s[k] = 1; return true; }); }
function plural(n, w){ return n + " " + (n === 1 ? w : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : w + "s"); }
var DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], DOW_LONG = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
var MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function dayLabel(s){ var d = parseIso(s); return DOW[d.getDay()] + " " + d.getDate() + " " + MON[d.getMonth()] + (s.slice(0, 4) !== today().slice(0, 4) ? " " + s.slice(0, 4) : ""); }
function monthLabel(ym){ return MONTHS[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4); }
function avg(list){ return list.length ? list.reduce(function(s, x){ return s + x; }, 0) / list.length : null; }
function r1(x){ return x == null ? "–" : (Math.round(x * 10) / 10).toFixed(1); }
function hm(min){ min = Math.round(min); return min < 60 ? min + "m" : Math.floor(min / 60) + "h" + (min % 60 ? " " + (min % 60) + "m" : ""); }
function normTags(a){ return uniq(arr(a).map(function(t){ return lower(t).slice(0, 40); }).filter(Boolean)).slice(0, 30); }

// ---------- data ----------
function fresh(){ return { v:1, days:{}, weeks:{}, months:{}, goals:[], moments:[] }; }
function normDay(x){
  x = obj(x);
  var m = {};
  SCALE_KEYS.forEach(function(k){ var v = obj(x.m)[k]; if(Number.isInteger(v) && v >= 1 && v <= 5) m[k] = v; });
  var tom = {};
  TOM_KEYS.forEach(function(k){ var v = str(obj(x.tom)[k], 300); if(v.trim()) tom[k] = v; });
  var ids = {};
  return { m:m, feel:str(x.feel, 20000),
    wins:arr(x.wins).filter(function(w){ return w && typeof w.text === "string"; }).slice(0, 50).map(function(w){
      var o = { id:str(w.id || rid("w"), 40), text:str(w.text, 300), hard:!!w.hard };
      if(ids[o.id]) o.id = rid("w"); ids[o.id] = 1;
      return o;
    }),
    chal:str(x.chal, 500), wrong:str(x.wrong, 20000), got:normTags(x.got), helped:normTags(x.helped),
    lessons:str(x.lessons, 20000), tom:tom, did:["yes", "partly", "no"].indexOf(x.did) >= 0 ? x.did : "",
    emo:normTags(x.emo).slice(0, 12), kind:str(x.kind, 5000),
    tr:arr(x.tr).filter(function(r){ return r && typeof r === "object"; }).slice(0, 5).map(normTR),
    ex:normEx(x.ex),
    at:isFinite(x.at) && +x.at > 0 ? +x.at : Date.now(), upd:isFinite(x.upd) && +x.upd > 0 ? +x.upd : Date.now() };
}
// a CBT thought record: situation, the automatic thought, the feeling and how strong
// (0..100), evidence for and against, a balanced thought, and the feeling afterwards
function pct(v){ return Number.isInteger(v) && v >= 0 && v <= 100 ? v : null; }
function normTR(r){
  return { id:str(r.id || rid("r"), 40), sit:str(r.sit, 2000), thought:str(r.thought, 1000), feel:str(r.feel, 200), before:pct(r.before),
           efor:str(r.efor, 2000), eagainst:str(r.eagainst, 2000), balanced:str(r.balanced, 2000), after:pct(r.after) };
}
function trHas(r){ return !!(r.sit.trim() || r.thought.trim() || r.feel.trim() || r.efor.trim() || r.eagainst.trim() || r.balanced.trim() || r.before != null || r.after != null); }
// an expressive writing session: minutes written, and the text unless you let it go
function normEx(x){
  if(!x || typeof x !== "object") return null;
  var o = { mins:int(x.mins, 0, 240), text:str(x.text, 50000), kept:x.kept !== false };
  return o.mins > 0 || o.text.trim() ? o : null;
}
function dayHas(d){
  return !!d && (Object.keys(d.m).length > 0 || !!d.feel.trim() || d.wins.some(function(w){ return w.text.trim(); }) || !!d.chal.trim() ||
    !!d.wrong.trim() || d.got.length > 0 || d.helped.length > 0 || !!d.lessons.trim() || Object.keys(d.tom).length > 0 || !!d.did ||
    d.emo.length > 0 || !!d.kind.trim() || d.tr.some(trHas) || !!d.ex);
}
function normText(x, keys, nums){
  x = obj(x);
  var o = {};
  keys.forEach(function(k){ var v = str(x[k], 20000); if(v.trim()) o[k] = v; });
  (nums || []).forEach(function(k){ if(Number.isInteger(x[k]) && x[k] >= 1 && x[k] <= 5) o[k] = x[k]; });
  o.at = isFinite(x.at) && +x.at > 0 ? +x.at : Date.now();
  o.upd = isFinite(x.upd) && +x.upd > 0 ? +x.upd : o.at;
  return o;
}
function textHas(o, keys, nums){ return keys.some(function(k){ return o[k] && o[k].trim(); }) || (nums || []).some(function(k){ return o[k]; }); }
function normalize(j){
  j = obj(j);
  var out = fresh();
  // an empty day, week or month (opened, never written) isn't kept
  Object.keys(obj(j.days)).forEach(function(k){ if(isIso(k)){ var d = normDay(j.days[k]); if(dayHas(d)) out.days[k] = d; } });
  Object.keys(obj(j.weeks)).forEach(function(k){
    if(isIso(k) && mondayOf(k) === k){ var w = normText(j.weeks[k], WEEK_KEYS, ["consistent"]); if(textHas(w, WEEK_KEYS, ["consistent"])) out.weeks[k] = w; }
  });
  Object.keys(obj(j.months)).forEach(function(k){
    if(isYm(k)){ var mo = normText(j.months[k], MONTH_KEYS, ["rate"]); if(textHas(mo, MONTH_KEYS, ["rate"])) out.months[k] = mo; }
  });
  var gids = {};
  out.goals = arr(j.goals).filter(function(g){ return g && typeof g.name === "string" && g.name.trim(); }).slice(0, 200).map(function(g){
    var o = { id:str(g.id || rid("g"), 40), name:str(g.name.trim(), 100), desc:str(g.desc, 1000),
      cat:CATS.indexOf(g.cat) >= 0 ? g.cat : "other", per:["day", "week", "month"].indexOf(g.per) >= 0 ? g.per : "week",
      n:1, start:isIso(g.start) ? g.start : today(), status:["active", "paused", "done", "dropped"].indexOf(g.status) >= 0 ? g.status : "active", checks:{} };
    o.n = o.per === "day" ? 1 : int(g.n, 1, o.per === "week" ? 7 : 31);
    o.ifp = str(g.ifp, 200); o.thenp = str(g.thenp, 200);      // the goal's if-then plan
    Object.keys(obj(g.checks)).forEach(function(d){ if(isIso(d)) o.checks[d] = 1; });
    if(gids[o.id]) o.id = rid("g"); gids[o.id] = 1;
    return o;
  });
  out.moments = arr(j.moments).filter(function(x){ return x && isIso(x.date) && typeof x.text === "string" && x.text.trim(); }).slice(0, 2000).map(function(x){
    return { id:str(x.id || rid("t"), 40), date:x.date, kind:x.kind === "realization" ? "realization" : "milestone", text:str(x.text.trim(), 500) };
  });
  return out;
}
function hasData(j){
  return !!j && (Object.keys(j.days).length > 0 || Object.keys(j.weeks).length > 0 || Object.keys(j.months).length > 0 || j.goals.length > 0 || j.moments.length > 0);
}

// ---------- reading entries ----------
function score(d){ var a = []; if(d.m.mood) a.push(d.m.mood); if(d.m.energy) a.push(d.m.energy); return a.length ? avg(a) : null; }
function didVal(d){ return d.did === "yes" ? 1 : d.did === "partly" ? 0.5 : d.did === "no" ? 0 : null; }
function datesIn(J, from, to){ return Object.keys(J.days).filter(function(k){ return k >= from && k <= to; }).sort(); }
function periodStats(J, from, to){
  var ds = datesIn(J, from, to), D = ds.map(function(k){ return J.days[k]; }), o = { n:ds.length, span:dayDiff(from, to) + 1, wins:0, tags:{}, helps:{} };
  SCALE_KEYS.forEach(function(k){ o[k] = avg(D.filter(function(d){ return d.m[k]; }).map(function(d){ return d.m[k]; })); });
  var dv = D.map(didVal).filter(function(x){ return x != null; });
  o.follow = dv.length ? avg(dv) : null; o.followN = dv.length;
  D.forEach(function(d){
    o.wins += d.wins.filter(function(w){ return w.text.trim(); }).length;
    d.got.forEach(function(t){ o.tags[t] = (o.tags[t] || 0) + 1; });
    d.helped.forEach(function(t){ o.helps[t] = (o.helps[t] || 0) + 1; });
  });
  return o;
}
function topTags(m, k){ return Object.keys(m).sort(function(a, b){ return m[b] - m[a]; }).slice(0, k || 3); }
// words that keep coming back in what went wrong
var STOPW = {};
("the and for that this with from are was were you your have has had not but can will would there their they them what when where which who how why into out about than then also just only some any all each other more most such very use used its it's our one two may might must should could does did done get got make made like way been being over under per via yes let here these those both well even much many too really didn didn't don't i'm ive i've im dont cant can't wasnt wasn't again still today day thing things time lot bit kind sort got going went want wanted need needed felt feel feeling") .split(" ").forEach(function(w){ STOPW[w] = 1; });
function words(text){ return (lower(text).match(/[a-z][a-z'\-]{2,}/g) || []).filter(function(w){ return !STOPW[w]; }); }

// ---------- DOM helpers ----------
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
function armed(btn, label, act){
  var t = null, orig = btn.textContent;
  btn.addEventListener("click", function(e){
    e.stopPropagation();
    if(!t){ btn.textContent = label; btn.classList.add("armed"); t = setTimeout(function(){ t = null; btn.textContent = orig; btn.classList.remove("armed"); }, 3000); return; }
    clearTimeout(t); act();
  });
  return btn;
}
// a growing text box that saves as you type (the browser's own undo works inside it)
function area(value, placeholder, onInput, cls){
  var ta = h("textarea", { class:"jn-ta" + (cls ? " " + cls : ""), rows:"2", placeholder:placeholder, spellcheck:"true", "data-native-undo":"", value:value || "" });
  function grow(){ ta.style.height = "auto"; ta.style.height = (ta.scrollHeight + 2) + "px"; }
  ta.addEventListener("input", function(){ grow(); onInput(ta.value); });
  requestAnimationFrame(grow);
  return ta;
}
function line(value, placeholder, onInput, cls){
  var inp = h("input", { class:"jn-in" + (cls ? " " + cls : ""), placeholder:placeholder, spellcheck:"true", "data-native-undo":"", value:value || "", maxlength:"300" });
  inp.addEventListener("input", function(){ onInput(inp.value); });
  return inp;
}
var LAYOUT_KEY = "journal-ui";
function layout(){ try{ return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; }catch(e){ return {}; } }
function saveLayout(o){ try{ localStorage.setItem(LAYOUT_KEY, JSON.stringify(o)); }catch(e){} }

// ---------- the page ----------
var uiState = {};
var TABS = ["today", "week", "month", "insights", "goals", "timeline"];

function mount(ctx){
  var p = ctx.page, J = p.journal, root = ctx.root, LY = layout();
  var u = uiState[p.id] || (uiState[p.id] = { tab:"today", date:today(), week:mondayOf(today()), month:today().slice(0, 7), range:30, q:"", kind:"", gform:null });
  function save(){ ctx.save(); }
  function commit(){ ctx.save(); draw(); }
  function dayOf(d, make){
    var x = J.days[d];
    if(!x && make){ x = J.days[d] = normDay({}); }
    if(x && make) x.upd = Date.now();
    return x || null;
  }
  function lastEntry(before){ var ks = Object.keys(J.days).filter(function(k){ return k < before && dayHas(J.days[k]); }).sort(); return ks[ks.length - 1] || null; }
  function open(tab, extra){ u.tab = tab; Object.keys(extra || {}).forEach(function(k){ u[k] = extra[k]; }); draw(); window.scrollTo(0, Math.min(window.scrollY, root.getBoundingClientRect().top + window.scrollY - 10)); }

  function draw(){
    root.innerHTML = "";
    root.classList.toggle("jn-hidden", !!LY.hide);
    root.appendChild(h("div", { class:"jn-bar" }, [
      h("div", { class:"jn-tabs", role:"tablist" }, TABS.map(function(t){
        return h("button", { type:"button", role:"tab", class:"jn-tab" + (u.tab === t ? " on" : ""), "aria-selected":u.tab === t ? "true" : "false", text:t,
          onclick:function(){ u.tab = t; if(t === "today") u.date = u.date || today(); draw(); } });
      })),
      h("span", { class:"jn-barr" }, [
        h("button", { type:"button", class:"jn-link" + (u.tab === "about" ? " on" : ""), title:"the research behind each part, and its limits", text:"why this works",
          onclick:function(){ open("about"); } }),
        h("button", { type:"button", class:"jn-link" + (LY.hide ? " on" : ""), title:"blur the page while someone is near your screen", text:LY.hide ? "show" : "hide",
          onclick:function(){ LY.hide = !LY.hide; saveLayout(LY); draw(); } })])
    ]));
    var body = h("div", { class:"jn-body" });
    root.appendChild(body);
    ({ today:todayView, week:weekView, month:monthView, insights:insightsView, goals:goalsView, timeline:timelineView, about:aboutView }[u.tab] || todayView)(body);
  }
  function section(title, kids, cls, extra, ev){
    return h("section", { class:"jn-sec" + (cls ? " " + cls : "") }, [h("div", { class:"jn-shead" }, [
      h("span", { class:"jn-shl" }, [h("h3", { class:"jn-sh", text:title }), ev ? evTag(ev) : null]), extra || null])].concat(kids));
  }
  function evTag(k){
    return h("button", { type:"button", class:"jn-ev k-" + k, text:EV[k], title:"how well this is backed: see why this works", onclick:function(){ open("about"); } });
  }
  function q(label, el){ return h("label", { class:"jn-q" }, [h("span", { text:label }), el]); }
  // five squares; the word for the chosen one shows beside them. Click it again to clear.
  function scale(key, label, wordsList, value, onSet){
    var wordEl = h("span", { class:"jn-sword", text:value ? wordsList[value - 1] : "" });
    return h("div", { class:"jn-scale s-" + key }, [h("span", { class:"jn-slabel", text:label }),
      h("div", { class:"jn-dots", role:"radiogroup", "aria-label":label }, [1, 2, 3, 4, 5].map(function(v){
        return h("button", { type:"button", role:"radio", "aria-checked":value === v ? "true" : "false", class:"jn-dot" + (value && v <= value ? " on" : "") + (value === v ? " cur" : ""),
          title:v + " · " + wordsList[v - 1], "aria-label":label + " " + v + ", " + wordsList[v - 1],
          onclick:function(){ onSet(value === v ? 0 : v); } }, [h("span", { text:String(v) })]);
      })), wordEl]);
  }
  function chips(all, picked, onToggle, addLabel){
    var box = h("div", { class:"jn-chips" });
    all.forEach(function(t){
      box.appendChild(h("button", { type:"button", class:"jn-chip" + (picked.indexOf(t) >= 0 ? " on" : ""), "aria-pressed":picked.indexOf(t) >= 0 ? "true" : "false", text:t,
        onclick:function(){ onToggle(t); } }));
    });
    var add = h("input", { class:"jn-chipin", placeholder:addLabel, maxlength:"40", "data-native-undo":"", "aria-label":addLabel,
      onkeydown:function(e){ if(e.key === "Enter" && add.value.trim()){ e.preventDefault(); onToggle(lower(add.value)); } } });
    box.appendChild(add);
    return box;
  }
  // every tag you've ever used, defaults first
  function vocab(list, key){
    var used = {};
    Object.keys(J.days).forEach(function(k){ J.days[k][key].forEach(function(t){ used[t] = (used[t] || 0) + 1; }); });
    return uniq(list.concat(Object.keys(used).sort(function(a, b){ return used[b] - used[a]; })));
  }

  // ===== TODAY: the check-in, and the full reflection when you want it =====
  function todayView(body){
    var t = today(), date = u.date || t, D = J.days[date] || normDay({}), isToday = date === t;
    function set(fn){ var x = dayOf(date, true); fn(x); save(); }
    // date navigation
    var pick = h("input", { type:"date", class:"jn-in jn-datein", value:date, max:t, "aria-label":"pick a day",
      onchange:function(){ if(isIso(pick.value) && pick.value <= t){ u.date = pick.value; draw(); } } });
    body.appendChild(h("div", { class:"jn-nav" }, [
      h("button", { type:"button", class:"jn-navb", text:"‹", "aria-label":"day before", onclick:function(){ u.date = addDays(date, -1); draw(); } }),
      h("div", { class:"jn-date" }, [h("b", { text:dayLabel(date) }), h("small", { text:isToday ? "today" : date === addDays(t, -1) ? "yesterday" : dayDiff(date, t) + " days ago" })]),
      h("button", { type:"button", class:"jn-navb", text:"›", "aria-label":"day after", disabled:isToday ? true : null, onclick:function(){ if(!isToday){ u.date = addDays(date, 1); draw(); } } }),
      pick,
      isToday ? null : h("button", { type:"button", class:"jn-link", text:"back to today", onclick:function(){ u.date = t; draw(); } })
    ]));
    // a gap is just information: no catching up asked
    if(isToday && !J.days[t]){
      var last = lastEntry(t);
      if(last && dayDiff(last, t) >= 3) body.appendChild(h("p", { class:"jn-quiet", text:"last entry " + dayDiff(last, t) + " days ago. no need to fill the gap: today is enough." }));
    }
    // the loop: what yesterday-you said mattered most, and whether it happened
    var prevKey = lastEntry(date), prev = prevKey && dayDiff(prevKey, date) <= 3 ? J.days[prevKey] : null;
    if(prev && prev.tom.first){
      body.appendChild(h("div", { class:"jn-loop" }, [
        h("span", { class:"jn-llab", text:(dayDiff(prevKey, date) === 1 ? "yesterday" : dayLabel(prevKey)) + (prev.tom.when ? " you planned" : " you said the most important thing was") }),
        h("b", { class:"jn-lgoal", text:prev.tom.when ? "when " + prev.tom.when + ", I'll " + prev.tom.first : prev.tom.first }),
        prev.tom.obst && prev.tom.cope ? h("small", { class:"jn-dim", text:"and if " + prev.tom.obst + ", then " + prev.tom.cope }) : null,
        h("div", { class:"jn-did" }, [["yes", "did it"], ["partly", "partly"], ["no", "didn't"]].map(function(o){
          return h("button", { type:"button", class:"jn-tog" + (D.did === o[0] ? " on" : ""), text:o[1],
            onclick:function(){ set(function(x){ x.did = x.did === o[0] ? "" : o[0]; }); draw(); } });
        }))
      ]));
    }
    if(isToday){ var care = careNote(); if(care) body.appendChild(care); }
    if(u.ex === date){ expressive(body, date, set); return; }
    // ---- the 2-minute check-in ----
    var win0 = D.wins[0] || null;
    var check = section("check-in", [
      scale("mood", "mood", SCALES[0][2], D.m.mood || 0, function(v){ set(function(x){ if(v) x.m.mood = v; else delete x.m.mood; }); draw(); }),
      scale("energy", "energy", SCALES[1][2], D.m.energy || 0, function(v){ set(function(x){ if(v) x.m.energy = v; else delete x.m.energy; }); draw(); }),
      h("div", { class:"jn-row" }, [
        q("biggest win", line(win0 ? win0.text : "", "small ones count", function(v){
          set(function(x){ if(x.wins.length) x.wins[0].text = v; else x.wins.push({ id:rid("w"), text:v, hard:false }); });
        })),
        win0 ? h("button", { type:"button", class:"jn-hard" + (win0.hard ? " on" : ""), title:"something hard I'd been avoiding", text:win0.hard ? "★ was avoiding it" : "☆ was avoiding it",
          onclick:function(){ set(function(x){ x.wins[0].hard = !x.wins[0].hard; }); draw(); } }) : null
      ]),
      q("biggest challenge", line(D.chal, "what got in the way, in a few words", function(v){ set(function(x){ x.chal = v.slice(0, 500); }); })),
      h("div", { class:"jn-row" }, [
        q("main thing for tomorrow", line(D.tom.first, "the one thing that matters most", function(v){ set(function(x){ if(v.trim()) x.tom.first = v; else delete x.tom.first; }); })),
        q("when and where?", line(D.tom.when, "e.g. 9:00 at my desk, after breakfast", function(v){ set(function(x){ if(v.trim()) x.tom.when = v; else delete x.tom.when; }); }))
      ])
    ], "jn-check", null, "R");
    body.appendChild(check);
    var full = !!LY.full;
    body.appendChild(h("button", { type:"button", class:"jn-more", "aria-expanded":full ? "true" : "false",
      text:full ? "▾ full reflection" : "▸ full reflection: feelings, wins, what went wrong, lessons, tomorrow",
      onclick:function(){ LY.full = !full; saveLayout(LY); draw(); } }));
    if(full) fullReflection(body, date, D, set);
    // the end of the page: when it was written, and clearing it
    body.appendChild(h("div", { class:"jn-foot" }, [
      h("small", { class:"jn-quiet", text:J.days[date] ? "saved as you type · last change " + new Date(J.days[date].upd).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }) : "nothing written for this day yet" }),
      J.days[date] ? armed(h("button", { type:"button", class:"jn-link", text:"clear this day" }), "sure? it can't be undone after a refresh", function(){ delete J.days[date]; commit(); }) : null
    ]));
  }
  function fullReflection(body, date, D, set){
    // A. how am I feeling: rate it, name it, then describe what happened (concrete, not "why am I like this")
    var prompt = FEEL_PROMPTS[(parseIso(date).getDate()) % FEEL_PROMPTS.length];
    body.appendChild(section("how am I feeling", SCALES.slice(2).map(function(S){
      return scale(S[0], S[1], S[2], D.m[S[0]] || 0, function(v){ set(function(x){ if(v) x.m[S[0]] = v; else delete x.m[S[0]]; }); draw(); });
    }).concat([
      h("span", { class:"jn-llab" }, ["name the feeling ", evTag("I")]),
      chips(uniq(EMOTIONS.concat(D.emo)), D.emo, function(tg){ set(function(x){ var i = x.emo.indexOf(tg); if(i >= 0) x.emo.splice(i, 1); else if(x.emo.length < 12) x.emo.push(tg); }); draw(); }, "+ another word"),
      area(D.feel, prompt + " what happened, and what am I feeling about it?", function(v){ set(function(x){ x.feel = v; }); }, "jn-write"),
      h("div", { class:"jn-row jn-exrow" }, [
        h("button", { type:"button", class:"jn-btn", text:"write it out · 15 min", title:"expressive writing: write freely about what's weighing on you",
          onclick:function(){ u.ex = date; u.exAt = Date.now(); draw(); } }), evTag("R"),
        D.ex ? h("small", { class:"jn-dim", text:"wrote for " + D.ex.mins + " min" + (D.ex.kept ? "" : " and let it go") }) : null
      ]),
      D.ex && D.ex.kept && D.ex.text.trim() ? h("details", { class:"jn-exsaved" }, [h("summary", { text:"what I wrote" }), h("div", { class:"jn-extext", text:D.ex.text })]) : null
    ]), "jn-a", null, "R"));
    // B. achievements: progress, however small
    var more = D.wins.slice(1);
    var addWin = line("", "+ another win (Enter)", function(){}, "jn-addwin");
    addWin.addEventListener("keydown", function(e){
      if(e.key !== "Enter" || !addWin.value.trim()) return;
      e.preventDefault();
      set(function(x){ if(!x.wins.length) x.wins.push({ id:rid("w"), text:"", hard:false }); x.wins.push({ id:rid("w"), text:addWin.value.trim().slice(0, 300), hard:false }); });
      draw(); var again = root.querySelector(".jn-addwin"); if(again) again.focus();
    });
    var work = ctx.dayWork ? ctx.dayWork(date) : null;
    var have = {}; D.wins.forEach(function(w){ have[lower(w.text)] = 1; });
    body.appendChild(section("what I achieved", [
      h("p", { class:"jn-hint", text:"progress toward my goals, what I'm proud of, anything hard I finally did. small wins count." }),
      more.length ? h("ul", { class:"jn-wins" }, more.map(function(w){
        return h("li", {}, [
          h("button", { type:"button", class:"jn-hard" + (w.hard ? " on" : ""), title:"something hard I'd been avoiding", text:w.hard ? "★" : "☆", "aria-label":"was avoiding it",
            onclick:function(){ set(function(x){ var y = x.wins.filter(function(z){ return z.id === w.id; })[0]; if(y) y.hard = !y.hard; }); draw(); } }),
          line(w.text, "", function(v){ set(function(x){ var y = x.wins.filter(function(z){ return z.id === w.id; })[0]; if(y) y.text = v; }); }, "jn-winin"),
          h("button", { type:"button", class:"jn-x", text:"×", "aria-label":"remove", onclick:function(){ set(function(x){ x.wins = x.wins.filter(function(z){ return z.id !== w.id; }); }); draw(); } })
        ]);
      })) : null,
      addWin,
      work && work.items.length ? h("div", { class:"jn-work" }, [
        h("span", { class:"jn-llab", text:"finished in your Command Center" + (work.mins ? " · " + hm(work.mins) : "") }),
        h("div", { class:"jn-chips" }, work.items.slice(0, 12).map(function(title){
          var got = !!have[lower(title)];
          return h("button", { type:"button", class:"jn-chip" + (got ? " on" : ""), disabled:got ? true : null, title:got ? "already a win" : "add as a win", text:(got ? "✓ " : "+ ") + title,
            onclick:function(){ set(function(x){ x.wins.push({ id:rid("w"), text:title, hard:false }); }); draw(); } });
        }))
      ]) : null,
      h("span", { class:"jn-llab", text:"what helped today" }),
      chips(vocab(HELPED, "helped"), D.helped, function(tg){ set(function(x){ var i = x.helped.indexOf(tg); if(i >= 0) x.helped.splice(i, 1); else x.helped.push(tg); }); draw(); }, "+ something else")
    ], "jn-b", null, "I"));
    // C. what went wrong: concrete facts, a kind word, and a thought record when a thought is stuck
    body.appendChild(section("what went wrong", [
      h("p", { class:"jn-hint", text:"honest, not harsh. stick to what happened, not what it says about you." }),
      chips(vocab(GOT, "got"), D.got, function(tg){ set(function(x){ var i = x.got.indexOf(tg); if(i >= 0) x.got.splice(i, 1); else x.got.push(tg); }); draw(); }, "+ something else"),
      area(D.wrong, "what exactly happened? when, where, and what was I doing just before? what could I try differently next time?", function(v){ set(function(x){ x.wrong = v; }); }, "jn-write"),
      h("span", { class:"jn-llab" }, ["a kinder look ", evTag("R")]),
      area(D.kind, "what would I say to a good friend who had this exact day? (everyone has days like this.)", function(v){ set(function(x){ x.kind = v; }); }),
      h("span", { class:"jn-llab" }, ["untangle a thought ", evTag("R")]),
      thoughtRecords(date, D, set)
    ], "jn-c", null, "I"));
    // D. lessons
    body.appendChild(section("what I learned", [
      area(D.lessons, "what did I learn, about the work or about myself? what would I do differently if I could replay today?",
        function(v){ set(function(x){ x.lessons = v; }); }, "jn-write"),
      momentAdd(date)
    ], "jn-d", null, "I"));
    // E. tomorrow: an if-then plan, plus a plan for the likely obstacle
    function tomField(key, label, ph){ return q(label, line(D.tom[key], ph, function(v){ set(function(x){ if(v.trim()) x.tom[key] = v; else delete x.tom[key]; }); paintPlan(); })); }
    var planEl = h("p", { class:"jn-plan" });
    function paintPlan(){
      var T = (J.days[date] || D).tom;
      planEl.textContent = T.first ? "when " + (T.when || "…") + ", I'll " + T.first + "." + (T.obst ? " if " + T.obst + ", then " + (T.cope || "…") + "." : "") : "";
      planEl.hidden = !T.first;
    }
    body.appendChild(section("tomorrow, as an if-then plan", [
      h("p", { class:"jn-hint", text:"one specific plan beats a long list. the main thing and its when-and-where are in the check-in above." }),
      h("div", { class:"jn-row" }, [tomField("obst", "what might get in the way?", "e.g. I'll want to check my phone first"), tomField("cope", "if that happens, then I will…", "e.g. put it in the other room and start the timer")]),
      tomField("stop", "one thing to stop", "optional"),
      planEl
    ], "jn-e", null, "R"));
    paintPlan();
    // commitments, checked by hand
    var act = J.goals.filter(function(g){ return g.status === "active" && g.start <= date; });
    if(act.length) body.appendChild(section("commitments", [h("div", { class:"jn-chips" }, act.map(function(g){
      var on = !!g.checks[date];
      return h("button", { type:"button", class:"jn-chip jn-gchip" + (on ? " on" : ""), "aria-pressed":on ? "true" : "false", text:(on ? "✓ " : "") + g.name,
        onclick:function(){ if(on) delete g.checks[date]; else g.checks[date] = 1; commit(); } });
    }))], "jn-f", h("button", { type:"button", class:"jn-link", text:"goals", onclick:function(){ open("goals"); } }), "R"));
  }
  // a CBT thought record, one per stuck thought (up to 5 a day)
  function thoughtRecords(date, D, set){
    var box = h("div", { class:"jn-trs" });
    box.appendChild(h("p", { class:"jn-hint", text:"for a thought that keeps bothering you: write the thought, then check it against the facts like a fair judge would." }));
    D.tr.forEach(function(r){ box.appendChild(trCard(r, set)); });
    if(D.tr.length < 5) box.appendChild(h("button", { type:"button", class:"jn-btn", text:"+ thought record",
      onclick:function(){ set(function(x){ x.tr.push(normTR({})); }); draw(); } }));
    return box;
  }
  function trCard(r, set){
    function upd(fn){ set(function(x){ var y = x.tr.filter(function(z){ return z.id === r.id; })[0]; if(y) fn(y); }); }
    function txt(key, label, ph){ return q(label, area(r[key], ph || "", function(v){ upd(function(y){ y[key] = v; }); })); }
    function num(key, label){
      var inp = h("input", { class:"jn-in jn-num", type:"number", min:"0", max:"100", step:"5", value:r[key] == null ? "" : String(r[key]), "data-native-undo":"", "aria-label":label,
        oninput:function(){ var v = inp.value === "" ? null : int(inp.value, 0, 100); upd(function(y){ y[key] = v; }); } });
      return q(label, inp);
    }
    var feel = line(r.feel, "e.g. anxious, ashamed", function(v){ upd(function(y){ y.feel = v.slice(0, 200); }); });
    return h("div", { class:"jn-tr" }, [
      txt("sit", "1. situation: what happened, where, when?"),
      txt("thought", "2. the thought that went through my head", "e.g. I'll never be good enough to pass this"),
      h("div", { class:"jn-row" }, [q("3. the feeling", feel), num("before", "how strong, 0–100")]),
      txt("efor", "4. facts that support the thought"),
      txt("eagainst", "5. facts that don't fit it"),
      txt("balanced", "6. a more balanced way to see it", "what would I tell a friend who had this thought?"),
      h("div", { class:"jn-row" }, [num("after", "7. the feeling now, 0–100"),
        armed(h("button", { type:"button", class:"jn-link", text:"remove" }), "sure?", function(){ set(function(x){ x.tr = x.tr.filter(function(z){ return z.id !== r.id; }); }); draw(); })])
    ]);
  }
  // expressive writing: about 15 minutes of free writing, then keep it or let it go
  var exTimer = null;
  function expressive(body, date, set){
    var D = J.days[date], started = u.exAt || (u.exAt = Date.now());
    var clock = h("b", { class:"jn-clock" });
    function tick(){ var m = Math.floor((Date.now() - started) / 60000); clock.textContent = m + " of ~15 min"; clock.classList.toggle("done", m >= 15); }
    tick(); clearInterval(exTimer);
    exTimer = setInterval(function(){ if(!clock.isConnected){ clearInterval(exTimer); return; } tick(); }, 15000);
    var ta = area(D && D.ex ? D.ex.text : "", "keep writing, don't stop to fix spelling or grammar. if you run out, repeat what you just wrote.", function(v){
      set(function(x){ if(!x.ex) x.ex = { mins:0, text:"", kept:true }; x.ex.text = v; });
    }, "jn-write jn-exta");
    function finish(keep){
      var mins = Math.max(1, Math.round((Date.now() - started) / 60000));
      set(function(x){ if(!x.ex) x.ex = { mins:0, text:"", kept:true }; x.ex.mins = Math.min(240, x.ex.mins + mins); x.ex.kept = keep; if(!keep) x.ex.text = ""; });
      clearInterval(exTimer); u.ex = null; u.exAt = 0; draw();
    }
    body.appendChild(section("write it out", [
      h("p", { class:"jn-hint", text:"for about 15 minutes, write about your deepest thoughts and feelings about what's on your mind: something that's bothering you, something you keep coming back to. write for yourself, nobody else will read it. at the end you can keep it or let it go." }),
      h("p", { class:"jn-note", text:"it's normal to feel a little stirred up right after; that usually passes. if it gets to be too much, stop. this is a writing exercise, not therapy." }),
      h("div", { class:"jn-row jn-exbar" }, [clock,
        h("button", { type:"button", class:"jn-btn jn-primary", text:"done: keep it", onclick:function(){ finish(true); } }),
        h("button", { type:"button", class:"jn-btn", text:"done: let it go", title:"delete what I wrote; only that I wrote is kept", onclick:function(){ finish(false); } }),
        h("button", { type:"button", class:"jn-link", text:"back to the check-in", onclick:function(){ clearInterval(exTimer); u.ex = null; draw(); } })]),
      ta
    ], "jn-ex", null, "R"));
    setTimeout(function(){ ta.focus(); }, 0);
  }
  // a gentle word when the check-ins have been low for a while. Not a screening or a diagnosis.
  function careNote(){
    var t = today(), last = datesIn(J, addDays(t, -13), t).map(function(k){ return J.days[k]; }).filter(function(d){ return d.m.mood; });
    var low = last.filter(function(d){ return d.m.mood <= 2; }).length;
    if(last.length < 6 || low / last.length < 0.6) return null;
    return h("div", { class:"jn-care" }, [
      h("span", { class:"jn-llab" }, ["a note ", evTag("X")]),
      h("p", { text:"your mood was low (1 or 2) on " + low + " of your last " + last.length + " check-ins over two weeks. this page can't tell you why, and it isn't a diagnosis. " +
        "when low mood or losing interest in things lasts two weeks or more, it's worth talking to someone you trust or a doctor. if you ever feel unsafe, contact your local emergency number or a crisis line." })
    ]);
  }
  // a milestone or a realization worth finding again in the timeline
  function momentAdd(date){
    var kind = h("select", { class:"jn-in jn-sel", "aria-label":"kind" }, [h("option", { value:"realization", text:"realization" }), h("option", { value:"milestone", text:"milestone" })]);
    var inp = h("input", { class:"jn-in", placeholder:"keep it for the timeline: a realization or a milestone (Enter)", maxlength:"500", "data-native-undo":"",
      onkeydown:function(e){ if(e.key === "Enter" && inp.value.trim()){ e.preventDefault(); J.moments.push({ id:rid("t"), date:date, kind:kind.value === "milestone" ? "milestone" : "realization", text:inp.value.trim().slice(0, 500) }); commit(); } } });
    var mine = J.moments.filter(function(m){ return m.date === date; });
    return h("div", { class:"jn-moments" }, mine.map(function(m){
      return h("div", { class:"jn-moment k-" + m.kind }, [h("span", { class:"jn-mk", text:m.kind }), h("span", { text:m.text }),
        armed(h("button", { type:"button", class:"jn-x", text:"×", "aria-label":"remove" }), "sure?", function(){ J.moments = J.moments.filter(function(x){ return x !== m; }); commit(); })]);
    }).concat([h("div", { class:"jn-row" }, [kind, inp])]));
  }

  // ===== shared: a strip of days, each a square coloured by mood =====
  function strip(from, n, onPick){
    var out = h("div", { class:"jn-strip" });
    for(var i = 0; i < n; i++){
      var d = addDays(from, i), D = J.days[d], s = D ? score(D) : null, fut = d > today();
      (function(d){
        out.appendChild(h("button", { type:"button", class:"jn-sq" + (fut ? " fut" : "") + (D ? " has" : "") + (s ? " m" + Math.round(s) : ""), disabled:fut ? true : null,
          title:dayLabel(d) + (D ? (D.m.mood ? " · mood " + D.m.mood : "") + (D.m.energy ? " · energy " + D.m.energy : "") : " · no entry"),
          onclick:function(){ onPick(d); } }, [h("small", { text:String(parseIso(d).getDate()) })]));
      })(d);
    }
    return out;
  }
  function compareTable(rows, aLabel, bLabel){
    return h("div", { class:"jn-twrap" }, [h("table", { class:"jn-table" }, [
      h("thead", {}, [h("tr", {}, ["", aLabel, bLabel].map(function(c){ return h("th", { text:c }); }))]),
      h("tbody", {}, rows.map(function(r){ return h("tr", {}, [h("td", { text:r[0] }), h("td", { class:"num", text:r[1] }), h("td", { class:"num jn-dim", text:r[2] })]); }))
    ])]);
  }
  function statRows(a, b){
    function pct(x){ return x == null ? "–" : Math.round(x * 100) + "%"; }
    return [["entries", a.n + " of " + a.span, b.n + " of " + b.span], ["mood", r1(a.mood), r1(b.mood)], ["energy", r1(a.energy), r1(b.energy)],
      ["stress", r1(a.stress), r1(b.stress)], ["wins written", String(a.wins), String(b.wins)], ["did tomorrow's main thing", pct(a.follow), pct(b.follow)]];
  }
  function reviewForm(store, key, groups, nums){
    var R = store[key] || {};
    function set(k, v){ var x = store[key] || (store[key] = { at:Date.now() }); x.upd = Date.now(); if(typeof v === "string" && !v.trim()) delete x[k]; else if(v === 0) delete x[k]; else x[k] = v; ctx.save(); }
    return groups.map(function(g){
      return section(g[0], g[1].map(function(qq){ return q(qq[1], area(R[qq[0]], "", function(v){ set(qq[0], v); })); }), "jn-rev", null, g[2]);
    }).concat(nums ? [section(nums[1], [scale(nums[0], "", nums[2], R[nums[0]] || 0, function(v){ set(nums[0], v); draw(); })], "jn-rev", null, nums[3])] : []);
  }

  // ===== WEEK =====
  function weekView(body){
    var mon = u.week, sun = addDays(mon, 6), t = today(), cur = mondayOf(t);
    body.appendChild(h("div", { class:"jn-nav" }, [
      h("button", { type:"button", class:"jn-navb", text:"‹", "aria-label":"week before", onclick:function(){ u.week = addDays(mon, -7); draw(); } }),
      h("div", { class:"jn-date" }, [h("b", { text:"week of " + dayLabel(mon) }), h("small", { text:mon === cur ? "this week" : mon === addDays(cur, -7) ? "last week" : dayLabel(sun) })]),
      h("button", { type:"button", class:"jn-navb", text:"›", "aria-label":"week after", disabled:mon >= cur ? true : null, onclick:function(){ if(mon < cur){ u.week = addDays(mon, 7); draw(); } } }),
      mon === cur ? null : h("button", { type:"button", class:"jn-link", text:"this week", onclick:function(){ u.week = cur; draw(); } })
    ]));
    var a = periodStats(J, mon, sun > t ? t : sun), b = periodStats(J, addDays(mon, -7), addDays(mon, -1)), prevR = J.weeks[addDays(mon, -7)];
    var ds = datesIn(J, mon, sun), wins = [];
    ds.forEach(function(d){ J.days[d].wins.forEach(function(w){ if(w.text.trim()) wins.push((w.hard ? "★ " : "") + w.text + " · " + dayLabel(d).slice(0, 3)); }); });
    body.appendChild(section("the week in your own entries", [
      strip(mon, 7, function(d){ open("today", { date:d }); }),
      prevR && prevR.focus ? h("p", { class:"jn-loop jn-loopsm" }, [h("span", { class:"jn-llab", text:"last week you said your focus would be" }), h("b", { text:prevR.focus })]) : null,
      wins.length ? h("div", {}, [h("span", { class:"jn-llab", text:"wins you wrote down" }), h("ul", { class:"jn-plain" }, wins.slice(0, 20).map(function(w){ return h("li", { text:w }); }))]) : null,
      Object.keys(a.tags).length ? h("p", { class:"jn-small" }, ["got in the way: ", topTags(a.tags, 5).map(function(k){ return k + " ×" + a.tags[k]; }).join(" · ")]) : null,
      compareTable(statRows(a, b), "this week", "the week before")
    ], "jn-ctx"));
    reviewForm(J.weeks, mon, WEEK_Q, ["consistent", "was I consistent with my priorities?", ["not at all", "barely", "partly", "mostly", "fully"], "R"]).forEach(function(s){ body.appendChild(s); });
    if(J.weeks[mon]) body.appendChild(h("div", { class:"jn-foot" }, [h("span"),
      armed(h("button", { type:"button", class:"jn-link", text:"clear this review" }), "sure?", function(){ delete J.weeks[mon]; commit(); })]));
  }

  // ===== MONTH =====
  function monthView(body){
    var ym = u.month, t = today(), cur = t.slice(0, 7), from = ym + "-01", to = ym + "-" + pad(daysInMonth(ym));
    var pym = addMonths(ym, -1), a = periodStats(J, from, to > t ? t : to), b = periodStats(J, pym + "-01", pym + "-" + pad(daysInMonth(pym)));
    body.appendChild(h("div", { class:"jn-nav" }, [
      h("button", { type:"button", class:"jn-navb", text:"‹", "aria-label":"month before", onclick:function(){ u.month = addMonths(ym, -1); draw(); } }),
      h("div", { class:"jn-date" }, [h("b", { text:monthLabel(ym) }), h("small", { text:ym === cur ? "this month" : "" })]),
      h("button", { type:"button", class:"jn-navb", text:"›", "aria-label":"month after", disabled:ym >= cur ? true : null, onclick:function(){ if(ym < cur){ u.month = addMonths(ym, 1); draw(); } } }),
      ym === cur ? null : h("button", { type:"button", class:"jn-link", text:"this month", onclick:function(){ u.month = cur; draw(); } })
    ]));
    var prevR = J.months[pym], weeksWritten = Object.keys(J.weeks).filter(function(k){ return k >= addDays(from, -6) && k <= to; }).length;
    var rows = statRows(a, b).concat([["weekly reviews", String(weeksWritten), String(Object.keys(J.weeks).filter(function(k){ return k >= addDays(pym + "-01", -6) && k < from; }).length)]]);
    body.appendChild(section("the month in your own entries", [
      strip(from, daysInMonth(ym), function(d){ open("today", { date:d }); }),
      prevR && prevR.next ? h("p", { class:"jn-loop jn-loopsm" }, [h("span", { class:"jn-llab", text:"last month you wanted this month to look like" }), h("b", { text:prevR.next })]) : null,
      Object.keys(a.tags).length ? h("p", { class:"jn-small" }, ["got in the way most: ", topTags(a.tags, 5).map(function(k){ return k + " ×" + a.tags[k]; }).join(" · ")]) : null,
      Object.keys(a.helps).length ? h("p", { class:"jn-small" }, ["helped most: ", topTags(a.helps, 5).map(function(k){ return k + " ×" + a.helps[k]; }).join(" · ")]) : null,
      compareTable(rows, monthLabel(ym).split(" ")[0], monthLabel(pym).split(" ")[0])
    ], "jn-ctx"));
    reviewForm(J.months, ym, [["the bigger picture", MONTH_Q, "I"]], ["rate", "how was this month, all in all?", ["rough", "hard", "mixed", "good", "great"], "I"]).forEach(function(s){ body.appendChild(s); });
    if(J.months[ym]) body.appendChild(h("div", { class:"jn-foot" }, [h("span"),
      armed(h("button", { type:"button", class:"jn-link", text:"clear this review" }), "sure?", function(){ delete J.months[ym]; commit(); })]));
  }

  // ===== INSIGHTS: patterns in your own entries =====
  function insightsView(body){
    var t = today(), all = Object.keys(J.days).sort();
    var R = u.range, from = R === "all" ? (all[0] || t) : addDays(t, -(R - 1));
    body.appendChild(h("div", { class:"jn-nav" }, [h("div", { class:"jn-toggle" }, [[7, "7 days"], [30, "30 days"], [90, "90 days"], ["all", "all time"]].map(function(o){
      return h("button", { type:"button", class:"jn-tog" + (R === o[0] ? " on" : ""), text:o[1], onclick:function(){ u.range = o[0]; draw(); } });
    }))]));
    var ds = datesIn(J, from, t), D = ds.map(function(k){ return J.days[k]; }), span = dayDiff(from, t) + 1;
    if(ds.length < 3){
      body.appendChild(h("div", { class:"jn-empty" }, [h("b", { text:"not enough entries yet" }),
        h("span", { text:"patterns need a few days to show. even a 2-minute check-in counts. " + (ds.length ? "so far: " + plural(ds.length, "entry") + " in this range." : "") })]));
      return;
    }
    var S = periodStats(J, from, t);
    function xsec(title, kids, cls, extra){ return section(title, kids, cls, extra, "X"); }
    var care = careNote(); if(care) body.appendChild(care);
    body.appendChild(h("p", { class:"jn-note", text:"everything here comes from what you wrote. when two things show up together, that's a pattern to look into, not proof that one causes the other." }));
    // consistency, without judgement
    var weeksN = Math.ceil(span / 7), perWeek = [];
    for(var w = 0; w < weeksN; w++){ var ws = addDays(from, w * 7), we = addDays(ws, 6); perWeek.push(datesIn(J, ws, we > t ? t : we).length); }
    var firstHalf = avg(perWeek.slice(0, Math.floor(perWeek.length / 2))), secondHalf = avg(perWeek.slice(Math.floor(perWeek.length / 2)));
    var trendTxt = perWeek.length >= 4 && firstHalf != null && secondHalf != null
      ? (secondHalf > firstHalf + 0.5 ? "you've been writing more often lately." : secondHalf < firstHalf - 0.5 ? "you've been writing less often lately than earlier in this range." : "you've written at a steady pace.") : "";
    body.appendChild(xsec("consistency", [
      h("p", { class:"jn-big" }, [h("b", { text:String(ds.length) }), " entries on " + span + " days", h("small", { text:trendTxt ? " · " + trendTxt : "" })]),
      R !== "all" && span <= 92 ? strip(from, span, function(d){ open("today", { date:d }); }) : null,
      perWeek.length > 1 ? bars(perWeek, 7, function(i){ return "week of " + dayLabel(addDays(from, i * 7)) + ": " + plural(perWeek[i], "entry"); }) : null
    ]));
    // mood and energy over time
    // averages, only for the scales you actually used
    var avgs = [];
    SCALE_KEYS.forEach(function(k){ if(S[k] != null){ if(avgs.length) avgs.push(" · "); avgs.push(k + " "); avgs.push(h("b", { text:r1(S[k]) })); } });
    body.appendChild(xsec("mood and energy", [trendChart(ds), avgs.length ? h("p", { class:"jn-small" }, ["averages: "].concat(avgs)) : null, trendNote(ds)]));
    // follow-through
    if(S.followN >= 3) body.appendChild(xsec("doing what I said mattered most", [
      h("p", { class:"jn-big" }, [h("b", { text:Math.round(S.follow * 100) + "%" }), " of the days you checked", h("small", { text:" (" + S.followN + " days; partly counts half)" })]),
      followByTag(ds)]));
    // tags beside mood: what shows up on better and worse days
    var tagged = tagEffects(D);
    if(tagged.got.length || tagged.helped.length) body.appendChild(xsec("what shows up on better and worse days", [
      tagged.got.length ? h("div", {}, [h("span", { class:"jn-llab", text:"got in the way" }), effectList(tagged.got)]) : null,
      tagged.helped.length ? h("div", {}, [h("span", { class:"jn-llab", text:"helped" }), effectList(tagged.helped)]) : null,
      h("p", { class:"jn-note", text:"only tags you used on 3+ days, compared with days without them (mood and energy averaged). a tag can sit next to a bad day without causing it: a bad night's sleep might cause both." })
    ]));
    // best and worst days
    var scored = ds.filter(function(k){ return score(J.days[k]) != null; }).sort(function(a, b){ return score(J.days[b]) - score(J.days[a]); });
    if(scored.length >= 6){
      var k = Math.max(2, Math.round(scored.length / 5)), best = scored.slice(0, k), worst = scored.slice(-k);
      body.appendChild(xsec("my best and worst days", [h("div", { class:"jn-two" }, [
        dayGroup("best " + k, best), dayGroup("hardest " + k, worst)
      ])]));
    }
    // weekdays
    var wd = weekdays(ds);
    if(wd) body.appendChild(xsec("by day of the week", [wd]));
    // recurring problems in my own words
    var rec = recurring(D);
    if(rec) body.appendChild(xsec("what keeps coming up", [rec]));
    // command center link
    var cc = workLink(ds);
    if(cc) body.appendChild(xsec("finished work and how I felt", [cc]));
    // the techniques themselves
    var pe = planEffect(ds);
    if(pe) body.appendChild(xsec("planning and follow-through", [pe,
      h("p", { class:"jn-note", text:"if-then planning helps in research; this only shows whether it went along with doing the main thing for you. busy or easy days can sway it either way." })]));
    var tu = toolUse(D);
    if(tu) body.appendChild(xsec("feelings, thought records and writing", [tu]));
    // goals
    var gl = J.goals.filter(function(g){ return g.status !== "dropped"; });
    if(gl.length) body.appendChild(xsec("commitments", [h("div", {}, gl.map(goalLine))], null, h("button", { type:"button", class:"jn-link", text:"goals", onclick:function(){ open("goals"); } })));
  }
  function bars(values, max, tip){
    var m = Math.max(max, Math.max.apply(null, values));
    return h("div", { class:"jn-bars" }, values.map(function(v, i){
      return h("i", { title:tip(i), style:"height:" + Math.max(4, v / m * 100) + "%" + (v ? "" : ";opacity:.35") });
    }));
  }
  // a hand-made line chart: mood (light) and energy (red), with a 7-entry average
  function trendChart(ds){
    var W = 600, H = 150, P = 6, n = ds.length;
    function x(i){ return n < 2 ? W / 2 : P + i / (n - 1) * (W - 2 * P); }
    function y(v){ return H - P - (v - 1) / 4 * (H - 2 * P); }
    function path(key){
      var pts = [];
      ds.forEach(function(d, i){
        var win = ds.slice(Math.max(0, i - 6), i + 1).map(function(k){ return J.days[k].m[key]; }).filter(Boolean);
        if(win.length) pts.push([x(i), y(avg(win))]);
      });
      return pts.length > 1 ? "M" + pts.map(function(p){ return p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" L") : "";
    }
    function dots(key, cls){
      return ds.map(function(d, i){ var v = J.days[d].m[key]; return v ? '<circle class="' + cls + '" cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.4"><title>' + dayLabel(d) + ": " + key + " " + v + "</title></circle>" : ""; }).join("");
    }
    var grid = [1, 2, 3, 4, 5].map(function(v){ return '<line class="jn-grid" x1="0" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '"/>'; }).join("");
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="mood and energy over time">' + grid +
      '<path class="jn-lmood" d="' + path("mood") + '"/><path class="jn-lenergy" d="' + path("energy") + '"/>' + dots("mood", "jn-dmood") + dots("energy", "jn-denergy") + "</svg>";
    var box = h("div", { class:"jn-chart" });
    box.innerHTML = svg;   // built only from numbers and dates made here
    return h("div", {}, [h("div", { class:"jn-legend" }, [h("span", {}, [h("i", { class:"jn-kmood" }), "mood"]), h("span", {}, [h("i", { class:"jn-kenergy" }), "energy"]),
      h("small", { text:"dots are days, lines a 7-entry average · 1 low to 5 high" })]), box,
      h("div", { class:"jn-axis" }, [h("small", { text:dayLabel(ds[0]) }), h("small", { text:dayLabel(ds[ds.length - 1]) })])]);
  }
  function trendNote(ds){
    if(ds.length < 8) return null;
    var half = Math.floor(ds.length / 2);
    function part(list, k){ return avg(list.map(function(d){ return J.days[d].m[k]; }).filter(Boolean)); }
    var a = part(ds.slice(0, half), "mood"), b = part(ds.slice(half), "mood"), ea = part(ds.slice(0, half), "energy"), eb = part(ds.slice(half), "energy");
    var bits = [];
    if(a != null && b != null && Math.abs(b - a) >= 0.4) bits.push("mood has been " + (b > a ? "higher" : "lower") + " in the second half of this range (" + r1(a) + " → " + r1(b) + ")");
    if(ea != null && eb != null && Math.abs(eb - ea) >= 0.4) bits.push("energy " + (eb > ea ? "higher" : "lower") + " (" + r1(ea) + " → " + r1(eb) + ")");
    return bits.length ? h("p", { class:"jn-insight", text:bits.join("; ") + "." }) : h("p", { class:"jn-insight", text:"no clear rise or fall in mood or energy across this range." });
  }
  function tagEffects(D){
    function side(key){
      var counts = {};
      D.forEach(function(d){ d[key].forEach(function(t){ counts[t] = (counts[t] || 0) + 1; }); });
      return Object.keys(counts).filter(function(t){ return counts[t] >= 3; }).map(function(t){
        var withT = D.filter(function(d){ return d[key].indexOf(t) >= 0 && score(d) != null; }), without = D.filter(function(d){ return d[key].indexOf(t) < 0 && score(d) != null; });
        var a = avg(withT.map(score)), b = avg(without.map(score));
        return { t:t, n:counts[t], a:a, b:b, diff:a != null && b != null && without.length >= 3 ? a - b : null };
      }).sort(function(x, y){ return y.n - x.n; }).slice(0, 8);
    }
    return { got:side("got"), helped:side("helped") };
  }
  function effectList(list){
    return h("ul", { class:"jn-effects" }, list.map(function(e){
      var txt = e.diff == null ? "not enough days without it to compare"
        : Math.abs(e.diff) < 0.3 ? "no real difference on those days (" + r1(e.a) + " vs " + r1(e.b) + ")"
        : "days with it averaged " + r1(e.a) + ", days without " + r1(e.b) + (e.diff < 0 ? ": you tend to feel worse on these days" : ": you tend to feel better on these days");
      return h("li", { class:e.diff != null && e.diff <= -0.3 ? "neg" : e.diff != null && e.diff >= 0.3 ? "pos" : "" }, [h("b", { text:e.t }), h("span", { class:"jn-dim", text:" · " + plural(e.n, "day") + " · " }), txt]);
    }));
  }
  function followByTag(ds){
    // on days after you tagged something, how often did tomorrow's main thing happen?
    var rows = [], by = {};
    ds.forEach(function(d){
      var D = J.days[d], v = didVal(D);
      if(v == null) return;
      var prev = J.days[addDays(d, -1)];
      if(!prev) return;
      prev.got.concat(prev.helped).forEach(function(t){ (by[t] = by[t] || []).push(v); });
    });
    Object.keys(by).filter(function(t){ return by[t].length >= 3; }).forEach(function(t){ rows.push([t, avg(by[t]), by[t].length]); });
    if(!rows.length) return null;
    rows.sort(function(a, b){ return a[1] - b[1]; });
    return h("div", {}, [h("span", { class:"jn-llab", text:"the day after you tagged…" }), h("ul", { class:"jn-effects" }, rows.slice(0, 6).map(function(r){
      return h("li", { class:r[1] < 0.5 ? "neg" : r[1] >= 0.75 ? "pos" : "" }, [h("b", { text:r[0] }), h("span", { class:"jn-dim", text:" · " + r[2] + " times · " }), "you did the main thing " + Math.round(r[1] * 100) + "% of the time"]);
    }))]);
  }
  function dayGroup(title, list){
    var helped = {}, got = {};
    list.forEach(function(d){ J.days[d].helped.forEach(function(t){ helped[t] = (helped[t] || 0) + 1; }); J.days[d].got.forEach(function(t){ got[t] = (got[t] || 0) + 1; }); });
    return h("div", {}, [h("span", { class:"jn-llab", text:title }),
      h("div", { class:"jn-chips" }, list.map(function(d){ return h("button", { type:"button", class:"jn-chip", text:dayLabel(d) + " · " + r1(score(J.days[d])), onclick:function(){ open("today", { date:d }); } }); })),
      h("p", { class:"jn-small" }, ["helped: ", topTags(helped, 4).map(function(k){ return k + " ×" + helped[k]; }).join(", ") || "nothing tagged"]),
      h("p", { class:"jn-small" }, ["got in the way: ", topTags(got, 4).map(function(k){ return k + " ×" + got[k]; }).join(", ") || "nothing tagged"])]);
  }
  var SLIP = ["procrastinated", "wasted time", "phone / social media", "distracted", "made excuses", "skipped the plan"];
  function weekdays(ds){
    var by = [0, 1, 2, 3, 4, 5, 6].map(function(){ return { n:0, mood:[], energy:[], slip:0 }; });
    ds.forEach(function(d){
      var D = J.days[d], w = parseIso(d).getDay(), B = by[w];
      B.n++; if(D.m.mood) B.mood.push(D.m.mood); if(D.m.energy) B.energy.push(D.m.energy);
      if(D.got.some(function(t){ return SLIP.indexOf(t) >= 0; })) B.slip++;
    });
    var order = [1, 2, 3, 4, 5, 6, 0], rows = order.map(function(w){ var B = by[w]; return { w:w, n:B.n, mood:avg(B.mood), energy:avg(B.energy), slip:B.n ? B.slip / B.n : null }; });
    var ok = rows.filter(function(r){ return r.n >= 2; });
    if(ok.length < 3) return null;
    var notes = [];
    var bySlip = ok.filter(function(r){ return r.slip != null; }).sort(function(a, b){ return b.slip - a.slip; });
    if(bySlip.length && bySlip[0].slip >= 0.4) notes.push("you tag procrastination or distraction most on " + DOW_LONG[bySlip[0].w] + " (" + Math.round(bySlip[0].slip * 100) + "% of those entries)");
    var byE = ok.filter(function(r){ return r.energy != null; }).sort(function(a, b){ return a.energy - b.energy; });
    if(byE.length >= 3 && byE[byE.length - 1].energy - byE[0].energy >= 0.6) notes.push("energy is lowest on " + DOW_LONG[byE[0].w] + " and highest on " + DOW_LONG[byE[byE.length - 1].w]);
    return h("div", {}, [h("div", { class:"jn-twrap" }, [h("table", { class:"jn-table jn-wd" }, [
      h("thead", {}, [h("tr", {}, ["", "entries", "mood", "energy", "slipped"].map(function(c){ return h("th", { text:c }); }))]),
      h("tbody", {}, rows.map(function(r){
        return h("tr", {}, [h("td", { text:DOW[r.w] }), h("td", { class:"num", text:String(r.n) }), h("td", { class:"num", text:r1(r.mood) }), h("td", { class:"num", text:r1(r.energy) }),
          h("td", { class:"num" + (r.slip != null && r.slip >= 0.4 ? " jn-red" : ""), text:r.slip == null ? "–" : Math.round(r.slip * 100) + "%" })]);
      }))])]),
      h("p", { class:"jn-note", text:"slipped = entries tagged procrastinated, wasted time, phone, distracted, made excuses or skipped the plan." }),
      notes.length ? h("p", { class:"jn-insight", text:notes.join("; ") + "." }) : null]);
  }
  function recurring(D){
    var tags = {}, wc = {};
    D.forEach(function(d){
      d.got.forEach(function(t){ tags[t] = (tags[t] || 0) + 1; });
      var seen = {};
      words(d.wrong + " " + d.chal).forEach(function(w){ if(!seen[w]){ seen[w] = 1; wc[w] = (wc[w] || 0) + 1; } });
    });
    var topT = topTags(tags, 6).filter(function(k){ return tags[k] >= 2; }), topW = Object.keys(wc).filter(function(k){ return wc[k] >= 3; }).sort(function(a, b){ return wc[b] - wc[a]; }).slice(0, 10);
    if(!topT.length && !topW.length) return null;
    return h("div", {}, [
      topT.length ? h("p", { class:"jn-small" }, ["tags: ", topT.map(function(k){ return k + " ×" + tags[k]; }).join(" · ")]) : null,
      topW.length ? h("p", { class:"jn-small" }, ["words that keep appearing in what went wrong: ", topW.map(function(k){ return k + " (" + wc[k] + " days)"; }).join(" · ")]) : null,
      h("p", { class:"jn-note", text:"repeated words often point at the real problem. search for one in the timeline to read those days together." })]);
  }
  function workLink(ds){
    if(!ctx.dayWork) return null;
    var hi = [], lo = [];
    ds.forEach(function(d){ var D = J.days[d], s = score(D); if(s == null) return; var w = ctx.dayWork(d); (w && w.mins >= 120 ? hi : lo).push(s); });
    if(hi.length < 3 || lo.length < 3) return null;
    var a = avg(hi), b = avg(lo);
    return h("div", {}, [h("p", { class:"jn-small" }, ["days with 2h+ finished in your Command Center: mood and energy ", h("b", { text:r1(a) }), " (" + hi.length + " days) · other days ", h("b", { text:r1(b) }), " (" + lo.length + " days)"]),
      h("p", { class:"jn-insight", text:Math.abs(a - b) < 0.3 ? "no real difference between those days." : a > b ? "you tend to feel better on days you get real work done. it could go either way: good days may also make work easier." : "you tend to feel worse on heavy work days. worth watching for overload." })]);
  }

  // ----- insights about the techniques themselves (experimental self-observation) -----
  // did if-then plans and obstacle plans go with doing the main thing? (the day's own check-ins)
  function planEffect(ds){
    var plan = [], none = [], cope = [], noCope = [];
    ds.forEach(function(d){
      var v = didVal(J.days[d]);
      if(v == null) return;
      var pk = lastEntry(d);
      if(!pk || dayDiff(pk, d) > 3 || !J.days[pk].tom.first) return;
      var T = J.days[pk].tom;
      (T.when ? plan : none).push(v);
      (T.obst && T.cope ? cope : noCope).push(v);
    });
    var rows = [];
    if(plan.length >= 3 && none.length >= 3) rows.push(["with a when-and-where", plan, "without one", none]);
    if(cope.length >= 3 && noCope.length >= 3) rows.push(["with an obstacle plan", cope, "without one", noCope]);
    if(!rows.length){
      if(plan.length + none.length < 3) return null;
      return h("p", { class:"jn-small", text:"not enough days on both sides to compare yet. once you've planned some days with a when-and-where and some without, this shows how often each turned into doing it." });
    }
    return h("ul", { class:"jn-effects" }, rows.map(function(r){
      var a = avg(r[1]), b = avg(r[3]);
      return h("li", { class:a - b >= 0.15 ? "pos" : a - b <= -0.15 ? "neg" : "" }, [h("b", { text:r[0] }), ": did the main thing " + Math.round(a * 100) + "% of the time (" + r[1].length + " days) · " + r[2] + ": " + Math.round(b * 100) + "% (" + r[3].length + " days)"]);
    }));
  }
  function toolUse(D){
    var trs = [], ex = 0, exMin = 0, emo = {}, kind = 0;
    D.forEach(function(d){
      d.tr.forEach(function(r){ if(trHas(r)) trs.push(r); });
      if(d.ex){ ex++; exMin += d.ex.mins; }
      d.emo.forEach(function(e){ emo[e] = (emo[e] || 0) + 1; });
      if(d.kind.trim()) kind++;
    });
    var both = trs.filter(function(r){ return r.before != null && r.after != null; });
    var topE = Object.keys(emo).sort(function(a, b){ return emo[b] - emo[a]; }).slice(0, 10);
    if(!trs.length && !ex && !topE.length && !kind) return null;
    return h("div", {}, [
      topE.length ? h("p", { class:"jn-small" }, ["feelings you named most: ", topE.map(function(e){ return e + " ×" + emo[e]; }).join(" · ")]) : null,
      trs.length ? h("p", { class:"jn-small" }, [plural(trs.length, "thought record"),
        both.length ? " · the feeling went from " + Math.round(avg(both.map(function(r){ return r.before; }))) + " to " + Math.round(avg(both.map(function(r){ return r.after; }))) + " out of 100 on average (" + plural(both.length, "record") + " with both numbers)" : ""]) : null,
      ex ? h("p", { class:"jn-small", text:plural(ex, "writing session") + ", " + plural(exMin, "minute") + " in all" }) : null,
      kind ? h("p", { class:"jn-small", text:"a kinder look written on " + plural(kind, "day") }) : null,
      h("p", { class:"jn-note", text:"a before/after drop on a thought record is your own rating straight after writing; it doesn't show a lasting change." })
    ]);
  }

  // ===== WHY THIS WORKS: what each part is based on, and how strong that is =====
  var EVIDENCE = [
    ["R", "research-based techniques", "established methods with a real research base. the evidence comes from studies of these techniques, often guided by a clinician or researcher; using them on your own here is a reasonable application, not the same as the studied treatment.", [
      ["the daily check-in and goal tracking", "self-monitoring", "keeping a record of what you do and how you feel is a core part of self-regulation. a meta-analysis of 138 studies (Harkin et al., 2016) found that monitoring progress toward a goal helped people reach it, more so when the progress was written down."],
      ["tomorrow as an if-then plan, and if-then plans on commitments", "implementation intentions", "deciding in advance \"when X happens, I will do Y\" makes follow-through more likely. a meta-analysis of 94 studies (Gollwitzer & Sheeran, 2006) found a medium-to-large effect on reaching goals."],
      ["the weekly wish, outcome, obstacle, plan", "mental contrasting with implementation intentions (WOOP)", "picturing the outcome you want, then the inner obstacle in the way, then an if-then plan for it. studies by Oettingen, Gollwitzer and colleagues found this helped people act on goals more than positive thinking alone."],
      ["commitments that are specific and measurable", "goal-setting", "specific, challenging goals with feedback lead to better performance than \"do your best\" (Locke & Latham's goal-setting research, summarised in 2002). the goal tab nudges toward specific targets and shows your own progress back to you."],
      ["untangle a thought", "CBT thought records (cognitive restructuring)", "noticing an automatic thought and weighing the evidence for and against it is a central technique in cognitive behavioural therapy, which has strong evidence for anxiety and depression (reviews of meta-analyses, e.g. Hofmann et al., 2012). here it is a self-help tool, not therapy."],
      ["write it out · 15 min", "expressive writing", "writing about your deepest thoughts and feelings for about 15 to 20 minutes, a few times (Pennebaker & Beall, 1986, and many studies since). meta-analyses find small average benefits (e.g. Frattaroli, 2006), and it can feel worse straight after. letting the text go is fine: the writing is what matters."],
      ["a kinder look, and the weekly 'what would I tell a friend'", "self-compassion", "treating your own mistakes with the kindness you'd show a friend (Neff). in experiments, self-compassion after a failure increased people's motivation to improve rather than lowering their standards (Breines & Chen, 2012), and it's linked with lower distress (MacBeth & Gumley, 2012)."]
    ]],
    ["I", "research-inspired design choices", "choices made because of what the research suggests, but not tested as they are built here.", [
      ["prompts about what happened, not why you're like this", "concrete thinking vs rumination", "work on rumination (e.g. Watkins) found that abstract \"why does this always happen to me\" thinking tends to keep low mood going, while concrete \"what happened, how, what next\" thinking is more helpful. so the questions ask for specifics."],
      ["name the feeling", "affect labelling", "putting a feeling into words was found to dampen emotional reactions in lab studies (Lieberman et al., 2007), and being able to tell feelings apart precisely is linked with coping better. the word list is a shortcut to that."],
      ["a 2-minute check-in, with depth only when you want it", "keeping self-monitoring going", "short, frequent check-ins are easier to keep up than long ones; a record you actually keep is worth more than a perfect one you abandon."],
      ["no points, streaks or guilt for missed days", "motivation and self-compassion", "rewards tied to doing an activity can reduce interest in it (Deci, Koestner & Ryan, 1999), and harsh self-criticism after lapses tends to backfire. so this page never scores you and treats gaps as information."],
      ["the accountability loop (did I do the main thing?)", "feedback on your own plans", "it combines self-monitoring with your if-then plan: you see, day by day, how often what you planned actually happened."],
      ["wins, weekly and monthly reviews", "reflection on progress", "noticing progress, even small, and reviewing regularly are widely recommended, but these exact questions haven't been tested as a set."]
    ]],
    ["X", "experimental", "built to help you notice things in your own entries. not validated, not predictions, and easy to over-read.", [
      ["everything on the insights tab", "personal pattern-finding", "the comparisons are simple averages over your own entries. small numbers of days, chance, and things you didn't record (sleep, illness, deadlines) can all create patterns that aren't real. two things showing up together never means one causes the other."],
      ["the low-mood note", "a simple rule, not a screening tool", "it only appears when most of your recent check-ins have a mood of 1 or 2. it can't detect depression or anything else, and its absence doesn't mean you're fine."],
      ["before/after numbers on thought records, and the follow-through comparisons", "self-rated, short-term", "they show your own ratings in the moment. they're useful for noticing, not for measuring change."]
    ]]
  ];
  function aboutView(body){
    body.appendChild(h("div", { class:"jn-care jn-disclaim" }, [
      h("b", { text:"what this page is, and isn't" }),
      h("p", { text:"a self-reflection tool built on ideas from psychology research. it isn't a diagnostic tool, therapy, or a replacement for professional help, and nothing here predicts anything about you. " +
        "if low mood, anxiety or losing interest in things lasts two weeks or more, or gets in the way of your life, talk to a doctor or a mental health professional. if you ever feel unsafe, contact your local emergency number or a crisis line." })
    ]));
    EVIDENCE.forEach(function(grp){
      body.appendChild(h("section", { class:"jn-sec jn-evsec" }, [
        h("div", { class:"jn-shead" }, [h("span", { class:"jn-shl" }, [h("h3", { class:"jn-sh", text:grp[1] }), h("span", { class:"jn-ev k-" + grp[0], text:EV[grp[0]] })])]),
        h("p", { class:"jn-hint", text:grp[2] }),
        h("div", { class:"jn-evlist" }, grp[3].map(function(f){
          return h("div", { class:"jn-evitem" }, [h("b", { text:f[0] }), h("small", { text:f[1] }), h("p", { text:f[2] })]);
        }))
      ]));
    });
    body.appendChild(h("p", { class:"jn-note", text:"references are named so you can look them up; summaries are simplified. if you learn something that contradicts this page, trust the evidence over the page." }));
  }

  // ===== GOALS: commitments you check yourself =====
  function periodKey(g, d){ return g.per === "day" ? d : g.per === "week" ? mondayOf(d) : d.slice(0, 7); }
  function goalProgress(g){
    var t = today(), cur = periodKey(g, t), counts = {};
    Object.keys(g.checks).forEach(function(d){ if(d >= g.start && d <= t){ var k = periodKey(g, d); counts[k] = (counts[k] || 0) + 1; } });
    // finished periods since the start (the current one is still open)
    function next(k, s){ return g.per === "day" ? addDays(k, s) : g.per === "week" ? addDays(k, 7 * s) : addMonths(k, s); }
    var periods = [], k = periodKey(g, g.start);
    for(var i = 0; i < 2000 && k < cur; i++){ periods.push(k); k = next(k, 1); }
    var met = periods.filter(function(p){ return (counts[p] || 0) >= g.n; }).length;
    var recent = [];
    var kk = cur;
    for(var j = 0; j < 8; j++){ recent.unshift({ k:kk, c:counts[kk] || 0 }); kk = next(kk, -1); }
    return { now:counts[cur] || 0, periods:periods.length, met:met, rate:periods.length ? met / periods.length : null, recent:recent, cur:cur };
  }
  function perWord(g){ return g.per === "day" ? "daily" : g.n + "× a " + g.per; }
  function goalLine(g){
    var G = goalProgress(g);
    return h("div", { class:"jn-gline" }, [h("b", { text:g.name }), h("span", { class:"jn-dim", text:" · " + perWord(g) + " · " }),
      G.rate == null ? "too early to tell" : "kept " + G.met + " of " + G.periods + " " + g.per + (G.periods === 1 ? "" : "s") + " (" + Math.round(G.rate * 100) + "%)"]);
  }
  function goalsView(body){
    var t = today();
    if(u.gform){ body.appendChild(goalForm()); }
    else body.appendChild(h("div", { class:"jn-nav" }, [h("p", { class:"jn-hint" }, ["a few commitments you hold yourself to, checked honestly by you. specific beats vague: \"3h of CWES on 5 days\" works better than \"study more\". ", evTag("R")]),
      h("button", { type:"button", class:"jn-btn jn-primary", text:"+ commitment", onclick:function(){ u.gform = { name:"", desc:"", cat:"study", per:"week", n:3, start:t }; draw(); } })]));
    var groups = [["active", "active"], ["paused", "paused"], ["done", "done"], ["dropped", "dropped"]];
    if(!J.goals.length && !u.gform){ body.appendChild(h("div", { class:"jn-empty" }, [h("b", { text:"no commitments yet" }), h("span", { text:"for example: study cybersecurity 3h on 5 days a week, or train 3× a week." })])); return; }
    groups.forEach(function(gr){
      var list = J.goals.filter(function(g){ return g.status === gr[0]; });
      if(!list.length) return;
      body.appendChild(section(gr[1], list.map(goalCard)));
    });
  }
  function goalCard(g){
    var t = today(), G = goalProgress(g), on = !!g.checks[t];
    var unit = g.per === "day" ? "today" : g.per === "week" ? "this week" : "this month";
    return h("div", { class:"jn-goal s-" + g.status }, [
      h("div", { class:"jn-ghead" }, [
        h("div", {}, [h("b", { text:g.name }), h("small", { text:[g.cat, perWord(g), "since " + dayLabel(g.start)].join(" · ") })]),
        g.status === "active" && g.start <= t ? h("button", { type:"button", class:"jn-btn" + (on ? " jn-primary" : ""), "aria-pressed":on ? "true" : "false", text:on ? "✓ did it today" : "did it today",
          onclick:function(){ if(on) delete g.checks[t]; else g.checks[t] = 1; commit(); } }) : null
      ]),
      g.desc ? h("p", { class:"jn-small", text:g.desc }) : null,
      g.thenp ? h("p", { class:"jn-plan jn-gplan" }, [h("span", { class:"jn-llab", text:"if-then plan" }), "when " + (g.ifp || "…") + ", I'll " + g.thenp + "."]) : null,
      h("div", { class:"jn-gprog" }, [
        h("span", { text:Math.min(G.now, g.n) + " / " + g.n + " " + unit }),
        h("div", { class:"jn-gbar" }, [h("i", { style:"width:" + Math.min(100, G.now / g.n * 100) + "%" })]),
        h("div", { class:"jn-grecent", title:"the last 8 " + g.per + "s, oldest first" }, G.recent.map(function(r){
          return h("i", { class:r.c >= g.n ? "met" : r.c ? "part" : "", title:(g.per === "month" ? monthLabel(r.k) : dayLabel(r.k)) + ": " + r.c + "/" + g.n });
        }))
      ]),
      h("p", { class:"jn-small" }, [G.rate == null ? "the first " + g.per + " isn't over yet." : "followed through on " + G.met + " of " + plural(G.periods, g.per) + " so far (" + Math.round(G.rate * 100) + "%)."]),
      h("div", { class:"jn-gacts" }, [
        h("select", { class:"jn-in jn-sel", "aria-label":"status", onchange:function(e){ g.status = e.target.value; commit(); } }, ["active", "paused", "done", "dropped"].map(function(s){ return h("option", { value:s, text:s, selected:g.status === s ? true : null }); })),
        h("button", { type:"button", class:"jn-link", text:"edit", onclick:function(){ u.gform = { id:g.id, name:g.name, desc:g.desc, cat:g.cat, per:g.per, n:g.n, start:g.start, ifp:g.ifp, thenp:g.thenp }; draw(); window.scrollTo(0, root.getBoundingClientRect().top + window.scrollY - 10); } }),
        armed(h("button", { type:"button", class:"jn-link", text:"delete" }), "sure? its history goes too", function(){ J.goals = J.goals.filter(function(x){ return x !== g; }); commit(); })
      ])
    ]);
  }
  function goalForm(){
    var F = u.gform, msg = h("p", { class:"jn-msg" });
    var nm = h("input", { class:"jn-in", value:F.name, maxlength:"100", placeholder:"e.g. study cybersecurity 3h", "data-native-undo":"", oninput:function(){ F.name = nm.value; } });
    var ds = h("textarea", { class:"jn-ta", rows:"2", maxlength:"1000", placeholder:"why it matters, what counts as done (optional)", "data-native-undo":"", oninput:function(){ F.desc = ds.value; } }); ds.value = F.desc || "";
    var cat = h("select", { class:"jn-in jn-sel", onchange:function(){ F.cat = cat.value; } }, CATS.map(function(c){ return h("option", { value:c, text:c, selected:F.cat === c ? true : null }); }));
    var n = h("input", { class:"jn-in jn-num", type:"number", min:"1", max:"31", value:String(F.n), "data-native-undo":"", oninput:function(){ F.n = +n.value; } });
    var per = h("select", { class:"jn-in jn-sel", onchange:function(){ F.per = per.value; n.disabled = F.per === "day"; } }, [["day", "every day"], ["week", "times a week"], ["month", "times a month"]].map(function(o){ return h("option", { value:o[0], text:o[1], selected:F.per === o[0] ? true : null }); }));
    n.disabled = F.per === "day";
    var st = h("input", { class:"jn-in", type:"date", value:F.start, onchange:function(){ F.start = st.value; } });
    function keep(){
      if(!F.name.trim()){ msg.textContent = "give it a name"; nm.focus(); return; }
      var g = F.id ? J.goals.filter(function(x){ return x.id === F.id; })[0] : null;
      var o = g || { id:rid("g"), status:"active", checks:{} };
      o.name = F.name.trim().slice(0, 100); o.desc = String(F.desc || "").slice(0, 1000); o.cat = F.cat; o.per = F.per;
      o.ifp = String(F.ifp || "").trim().slice(0, 200); o.thenp = String(F.thenp || "").trim().slice(0, 200);
      o.n = F.per === "day" ? 1 : int(F.n, 1, F.per === "week" ? 7 : 31); o.start = isIso(F.start) ? F.start : today();
      if(!g) J.goals.push(o);
      u.gform = null; commit();
    }
    return h("section", { class:"jn-sec jn-gform" }, [h("div", { class:"jn-shead" }, [h("h3", { class:"jn-sh", text:F.id ? "edit commitment" : "new commitment" })]),
      q("name", nm), q("description", ds),
      h("div", { class:"jn-row" }, [
        q("if-then plan: when…", h("input", { class:"jn-in", value:F.ifp || "", maxlength:"200", placeholder:"e.g. I sit down after dinner", "data-native-undo":"", oninput:function(e){ F.ifp = e.target.value; } })),
        q("…then I will", h("input", { class:"jn-in", value:F.thenp || "", maxlength:"200", placeholder:"e.g. open the lab before anything else", "data-native-undo":"", oninput:function(e){ F.thenp = e.target.value; } }))]),
      h("div", { class:"jn-grid" }, [q("category", cat), q("how often", h("div", { class:"jn-row" }, [n, per])), q("from", st)]),
      msg, h("div", { class:"jn-row" }, [h("button", { type:"button", class:"jn-btn jn-primary", text:F.id ? "save" : "add it", onclick:keep }),
        h("button", { type:"button", class:"jn-link", text:"cancel", onclick:function(){ u.gform = null; draw(); } })])]);
  }

  // ===== TIMELINE: everything, in order =====
  function items(){
    var out = [];
    Object.keys(J.days).forEach(function(d){
      var D = J.days[d], win = D.wins.filter(function(w){ return w.text.trim(); });
      var bits = [win.length ? "won: " + win.map(function(w){ return w.text; }).join(", ") : "", D.chal ? "challenge: " + D.chal : "", D.lessons ? "learned: " + D.lessons : "", D.feel].filter(Boolean);
      out.push({ kind:"day", date:d, title:dayLabel(d), text:bits.join(" · "), mood:D.m.mood || 0, hard:win.some(function(w){ return w.hard; }),
        hay:[D.feel, D.chal, D.wrong, D.lessons, D.kind, D.got.join(" "), D.helped.join(" "), D.emo.join(" "), D.ex && D.ex.kept ? D.ex.text : ""].concat(D.tr.map(function(r){ return [r.sit, r.thought, r.balanced].join(" "); })).concat(win.map(function(w){ return w.text; })).concat(Object.keys(D.tom).map(function(k){ return D.tom[k]; })).join(" "),
        go:function(){ open("today", { date:d }); } });
    });
    Object.keys(J.weeks).forEach(function(k){ var W = J.weeks[k];
      out.push({ kind:"week", date:addDays(k, 6), title:"week of " + dayLabel(k), text:[W.wins ? "wins: " + W.wins : "", W.focus ? "next focus: " + W.focus : ""].filter(Boolean).join(" · "),
        hay:WEEK_KEYS.map(function(q_){ return W[q_] || ""; }).join(" "), go:function(){ open("week", { week:k }); } }); });
    Object.keys(J.months).forEach(function(k){ var M = J.months[k];
      out.push({ kind:"month", date:k + "-" + pad(daysInMonth(k)), title:monthLabel(k), text:[M.proud ? "proud of: " + M.proud : "", M.changed ? "changed: " + M.changed : ""].filter(Boolean).join(" · "),
        hay:MONTH_KEYS.map(function(q_){ return M[q_] || ""; }).join(" "), go:function(){ open("month", { month:k }); } }); });
    J.moments.forEach(function(m){ out.push({ kind:m.kind, date:m.date, title:dayLabel(m.date), text:m.text, hay:m.text, go:function(){ open("today", { date:m.date }); } }); });
    J.goals.forEach(function(g){ out.push({ kind:"goal", date:g.start, title:"commitment: " + g.name, text:perWord(g) + " · now " + g.status, hay:g.name + " " + g.desc, go:function(){ open("goals"); } }); });
    return out.sort(function(a, b){ return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  }
  function timelineView(body){
    var all = items();
    var search = h("input", { class:"jn-in jn-search", type:"search", placeholder:"search everything you wrote", value:u.q, "data-native-undo":"", "aria-label":"search",
      oninput:function(){ u.q = search.value; paint(); } });
    var kinds = [["", "all"], ["day", "days"], ["week", "weeks"], ["month", "months"], ["milestone", "milestones"], ["realization", "realizations"], ["goal", "commitments"]];
    body.appendChild(h("div", { class:"jn-nav" }, [search, h("div", { class:"jn-toggle" }, kinds.map(function(k){
      return h("button", { type:"button", class:"jn-tog" + (u.kind === k[0] ? " on" : ""), text:k[1], onclick:function(){ u.kind = k[0]; draw(); } });
    }))]));
    var out = h("div", { class:"jn-tl" }), count = h("p", { class:"jn-quiet" });
    body.appendChild(count); body.appendChild(out);
    function paint(){
      var qq = lower(u.q), list = all.filter(function(x){ return (!u.kind || x.kind === u.kind) && (!qq || (x.title + " " + x.hay).toLowerCase().indexOf(qq) >= 0); });
      out.innerHTML = "";
      count.textContent = all.length ? list.length + " of " + all.length : "";
      if(!all.length){ out.appendChild(h("div", { class:"jn-empty" }, [h("b", { text:"nothing here yet" }), h("span", { text:"your entries, reviews, milestones and realizations collect here, newest first." })])); return; }
      var lastM = "";
      list.slice(0, 400).forEach(function(x){
        var m = x.date.slice(0, 7);
        if(m !== lastM){ out.appendChild(h("div", { class:"jn-tlm", text:monthLabel(m) })); lastM = m; }
        out.appendChild(h("button", { type:"button", class:"jn-tli k-" + x.kind, onclick:x.go }, [
          h("span", { class:"jn-tld", text:x.kind === "day" ? String(+x.date.slice(8)) : "" }),
          h("span", { class:"jn-tlb" }, [h("b", {}, [x.title, x.mood ? h("i", { class:"jn-mdot m" + x.mood, title:"mood " + x.mood }) : null, x.hard ? h("span", { class:"jn-star", title:"did something hard", text:" ★" }) : null,
            x.kind !== "day" ? h("span", { class:"jn-kind", text:x.kind }) : null]),
            x.text ? h("small", { text:x.text.length > 220 ? x.text.slice(0, 219) + "…" : x.text }) : null])
        ]));
      });
    }
    paint();
  }

  draw();
}

// ---------- styles ----------
var css = `
.jn{margin-top:.5rem;}
.jn.jn-hidden .jn-body{filter:blur(9px); user-select:none; pointer-events:none;}
.jn-bar{display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; flex-wrap:wrap; border-bottom:2px solid var(--line); margin-bottom:1.6rem;}
.jn-tabs{display:flex; flex-wrap:wrap;}
.jn-tab{background:transparent; border:none; border-bottom:2px solid transparent; margin-bottom:-2px; color:var(--muted); font:inherit; font-size:.68rem; letter-spacing:.12em;
  text-transform:uppercase; padding:.55rem .7rem; cursor:pointer;}
.jn-tab:hover{color:var(--fg);}
.jn-tab.on{color:var(--fg); border-bottom-color:var(--accent);}
.jn-link{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.68rem; letter-spacing:.05em; padding:.3rem .35rem; cursor:pointer;}
.jn-link:hover, .jn-link.on{color:var(--fg);}
.jn-link.armed{color:var(--accent);}
.jn-btn{background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.64rem; letter-spacing:.1em; text-transform:uppercase; padding:.4rem .7rem; cursor:pointer; white-space:nowrap;}
.jn-btn:hover{border-color:var(--fg);}
.jn-primary{border-color:var(--accent); background:var(--accent); color:var(--accent-ink); font-weight:700;}
.jn-nav{display:flex; align-items:center; gap:.6rem 1rem; flex-wrap:wrap; margin-bottom:1.2rem;}
.jn-navb{background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; font-size:1rem; width:2.2rem; height:2.2rem; cursor:pointer;}
.jn-navb:hover:not([disabled]){border-color:var(--fg);}
.jn-navb[disabled]{opacity:.3; cursor:default;}
.jn-date{display:flex; flex-direction:column; min-width:9rem;}
.jn-date b{font-size:1.05rem; letter-spacing:.06em; text-transform:uppercase;}
.jn-date small{font-size:.62rem; color:var(--muted); letter-spacing:.08em;}
.jn-nav .jn-datein{width:auto; flex:0 0 auto; font-family:inherit; font-size:.7rem; padding:.3rem .4rem; border:2px solid var(--line);}
.jn-quiet{color:var(--muted); font-size:.68rem; letter-spacing:.03em; margin:0 0 1rem;}
.jn-hint{color:var(--muted); font-size:.68rem; line-height:1.6; margin:0 0 .7rem;}
.jn-note{color:var(--muted); font-size:.64rem; line-height:1.6; margin:.4rem 0 1.2rem; border-left:2px solid var(--line); padding-left:.7rem;}
.jn-small{font-size:.72rem; line-height:1.6; margin:.35rem 0;}
.jn-small b{color:var(--fg);}
.jn-dim{color:var(--muted);}
.jn-red{color:var(--accent);}
.jn-insight{font-size:.76rem; line-height:1.6; margin:.5rem 0 0; padding:.5rem .7rem; border:2px solid var(--line); border-left-color:var(--accent);}
.jn-sec{margin-bottom:1.8rem;}
.jn-shead{display:flex; justify-content:space-between; align-items:baseline; gap:1rem; margin-bottom:.7rem;}
.jn-sh{margin:0; font-size:.64rem; font-weight:700; letter-spacing:.16em; text-transform:uppercase; color:var(--muted);}
.jn-check{border:2px solid var(--line); padding:1rem 1.1rem .4rem;}
.jn-check .jn-sh{color:var(--accent);}
.jn-llab{display:block; font-size:.58rem; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin:.8rem 0 .4rem;}
.jn-q{display:flex; flex-direction:column; gap:.3rem; margin-bottom:.8rem; font-size:.6rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); flex:1 1 auto; min-width:0;}
.jn-q > *:not(span){text-transform:none; letter-spacing:0;}
.jn-in{background:var(--bg); border:none; border-bottom:2px solid var(--line); color:var(--fg); font-family:var(--sans); font-size:.88rem; padding:.4rem .1rem; outline:none; width:100%; border-radius:0; color-scheme:dark;}
.jn-in:focus{border-bottom-color:var(--accent);}
.jn-in::placeholder, .jn-ta::placeholder{color:#555;}
.jn-sel{font-family:inherit; font-size:.72rem; width:auto; cursor:pointer; border:2px solid var(--line); padding:.3rem .4rem;}
.jn-num{width:4rem; font-family:inherit;}
.jn-ta{display:block; width:100%; resize:none; overflow:hidden; background:transparent; border:2px solid var(--line); color:var(--fg); font-family:var(--sans); font-size:.9rem;
  line-height:1.7; padding:.7rem .8rem; outline:none; border-radius:0; min-height:3.4rem;}
.jn-ta:focus{border-color:#555;}
.jn-write{min-height:5.5rem;}
.jn-row{display:flex; align-items:flex-end; gap:.6rem; flex-wrap:wrap;}
.jn-row .jn-q{flex:1 1 14rem;}
.jn-scale{display:flex; align-items:center; gap:.8rem; margin-bottom:.8rem; flex-wrap:wrap;}
.jn-slabel{flex:0 0 6.5rem; font-size:.62rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted);}
.jn-dots{display:flex; gap:4px;}
.jn-dot{width:2rem; height:2rem; background:transparent; border:2px solid var(--line); color:var(--muted); font:inherit; font-size:.62rem; cursor:pointer; padding:0;}
.jn-dot:hover{border-color:var(--fg); color:var(--fg);}
.jn-dot.on{background:#3a1718; border-color:#7a2a2c; color:var(--fg);}
.jn-dot.cur{background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:700;}
.s-stress .jn-dot.on{background:#262626; border-color:#555;}
.s-stress .jn-dot.cur{background:var(--fg); border-color:var(--fg); color:var(--bg);}
.jn-sword{font-size:.72rem; color:var(--fg); min-width:5rem;}
.jn-hard{background:transparent; border:2px solid var(--line); color:var(--muted); font:inherit; font-size:.62rem; padding:.35rem .55rem; cursor:pointer; margin-bottom:.8rem; white-space:nowrap;}
.jn-hard.on{border-color:var(--accent); color:var(--accent);}
.jn-more{display:block; width:100%; text-align:left; background:transparent; border:2px dashed var(--line); color:var(--muted); font:inherit; font-size:.7rem; letter-spacing:.04em;
  padding:.7rem .9rem; cursor:pointer; margin:0 0 1.8rem;}
.jn-more:hover{color:var(--fg); border-color:var(--muted);}
.jn-loop{border:2px solid var(--accent); padding:.8rem 1rem; margin-bottom:1.4rem; display:flex; flex-direction:column; gap:.4rem;}
.jn-loop .jn-llab{margin:0;}
.jn-lgoal{font-size:1rem; font-family:var(--sans);}
.jn-loopsm{border-width:2px; border-color:var(--line); border-left-color:var(--accent); padding:.6rem .8rem; margin:.8rem 0;}
.jn-loopsm b{font-family:var(--sans); font-size:.88rem;}
.jn-did, .jn-toggle{display:flex; flex-wrap:wrap;}
.jn-tog{background:transparent; border:2px solid var(--line); color:var(--muted); font:inherit; font-size:.6rem; letter-spacing:.1em; text-transform:uppercase; padding:.35rem .7rem; cursor:pointer;}
.jn-tog + .jn-tog{border-left:none;}
.jn-tog:hover{color:var(--fg);}
.jn-tog.on{background:var(--accent); border-color:var(--accent); color:var(--accent-ink);}
.jn-chips{display:flex; flex-wrap:wrap; gap:.35rem; margin:.2rem 0 .8rem;}
.jn-chip{background:transparent; border:2px solid var(--line); color:var(--muted); font:inherit; font-size:.66rem; padding:.28rem .55rem; cursor:pointer;}
.jn-chip:hover:not([disabled]){color:var(--fg); border-color:var(--muted);}
.jn-chip.on{border-color:var(--accent); color:var(--fg); background:#1d1011;}
.jn-chip[disabled]{cursor:default;}
.jn-chipin{background:transparent; border:none; border-bottom:2px solid var(--line); color:var(--fg); font:inherit; font-size:.66rem; padding:.25rem .1rem; width:9rem; outline:none;}
.jn-chipin:focus{border-bottom-color:var(--accent);}
.jn-wins{list-style:none; margin:0 0 .6rem; padding:0; display:flex; flex-direction:column; gap:.3rem;}
.jn-wins li{display:flex; align-items:center; gap:.4rem;}
.jn-wins .jn-hard{margin:0; padding:.2rem .45rem;}
.jn-winin{flex:1 1 auto;}
.jn-x{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.9rem; cursor:pointer; padding:0 .3rem;}
.jn-x:hover, .jn-x.armed{color:var(--accent);}
.jn-addwin{margin-bottom:.8rem;}
.jn-work{margin:.2rem 0 .6rem;}
.jn-moments{display:flex; flex-direction:column; gap:.35rem; margin-top:.8rem;}
.jn-moment{display:flex; align-items:baseline; gap:.6rem; font-size:.82rem; font-family:var(--sans); border-left:2px solid var(--fg); padding:.2rem .6rem;}
.jn-moment.k-milestone{border-left-color:var(--accent);}
.jn-mk{font-family:var(--mono); font-size:.56rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted);}
.jn-foot{display:flex; justify-content:space-between; align-items:center; gap:1rem; border-top:2px solid var(--line); padding-top:.7rem; margin-top:.4rem;}
.jn-foot .jn-quiet{margin:0;}
.jn-strip{display:flex; flex-wrap:wrap; gap:3px; margin:.2rem 0 .8rem;}
.jn-sq{width:1.7rem; height:1.7rem; border:2px solid var(--line); background:transparent; color:var(--muted); font:inherit; padding:0; cursor:pointer; display:flex; align-items:center; justify-content:center;}
.jn-sq small{font-size:.5rem;}
.jn-sq.has{border-color:#555;}
.jn-sq.m1{background:#2a2a2a;} .jn-sq.m2{background:#3a2020;} .jn-sq.m3{background:#5a2021;} .jn-sq.m4{background:#9a3133;} .jn-sq.m5{background:var(--accent); color:var(--accent-ink);}
.jn-sq.fut{opacity:.25; cursor:default;}
.jn-sq:hover:not(.fut){border-color:var(--fg);}
.jn-twrap{overflow-x:auto; margin:.6rem 0;}
.jn-table{border-collapse:collapse; font-size:.74rem; min-width:60%;}
.jn-table th{text-align:left; border-bottom:2px solid var(--fg); padding:.35rem .6rem; font-size:.58rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); font-weight:400;}
.jn-table td{border-bottom:2px solid var(--line); padding:.38rem .6rem;}
.jn-table td.num{text-align:right; font-variant-numeric:tabular-nums;}
.jn-rev .jn-ta{font-size:.86rem;}
.jn-big{font-size:.8rem; margin:0 0 .6rem;}
.jn-big b{font-size:1.5rem; color:var(--accent); margin-right:.35rem;}
.jn-big small{color:var(--muted); font-size:.66rem;}
.jn-bars{display:flex; align-items:flex-end; gap:3px; height:48px; border-bottom:2px solid var(--line); margin-top:.4rem;}
.jn-bars i{flex:1 1 0; background:var(--fg); max-width:22px;}
.jn-chart{border:2px solid var(--line); padding:.4rem;}
.jn-chart svg{display:block; width:100%; height:150px; overflow:visible;}
.jn-grid{stroke:var(--line); stroke-width:1; vector-effect:non-scaling-stroke;}
.jn-lmood{fill:none; stroke:var(--fg); stroke-width:2; vector-effect:non-scaling-stroke;}
.jn-lenergy{fill:none; stroke:var(--accent); stroke-width:2; vector-effect:non-scaling-stroke;}
.jn-dmood{fill:var(--fg); opacity:.45;}
.jn-denergy{fill:var(--accent); opacity:.45;}
.jn-legend{display:flex; gap:1rem; align-items:center; flex-wrap:wrap; font-size:.6rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:.4rem;}
.jn-legend span{display:inline-flex; align-items:center; gap:.35rem;}
.jn-legend i{display:inline-block; width:14px; height:3px;}
.jn-legend small{text-transform:none; letter-spacing:.02em; margin-left:auto;}
.jn-kmood{background:var(--fg);} .jn-kenergy{background:var(--accent);}
.jn-axis{display:flex; justify-content:space-between; color:var(--muted); font-size:.58rem; margin-top:.25rem;}
.jn-effects{list-style:none; margin:0 0 .6rem; padding:0; display:flex; flex-direction:column; gap:.3rem; font-size:.74rem; line-height:1.55;}
.jn-effects li{padding-left:.7rem; border-left:2px solid var(--line);}
.jn-effects li.neg{border-left-color:var(--accent);}
.jn-effects li.pos{border-left-color:var(--fg);}
.jn-two{display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); gap:1.6rem;}
.jn-empty{border:2px dashed var(--line); padding:1.3rem; display:flex; flex-direction:column; gap:.45rem; font-size:.74rem; color:var(--muted); line-height:1.6;}
.jn-empty b{color:var(--fg); letter-spacing:.1em; text-transform:uppercase; font-size:.72rem;}
.jn-goal{border:2px solid var(--line); padding:.8rem .9rem; margin-bottom:.7rem;}
.jn-goal.s-paused, .jn-goal.s-dropped{opacity:.6;}
.jn-ghead{display:flex; justify-content:space-between; align-items:flex-start; gap:1rem;}
.jn-ghead b{display:block; font-size:.9rem; font-family:var(--sans);}
.jn-ghead small{color:var(--muted); font-size:.62rem; letter-spacing:.06em;}
.jn-gprog{display:flex; align-items:center; gap:.7rem; flex-wrap:wrap; margin:.7rem 0 .3rem; font-size:.7rem;}
.jn-gbar{flex:1 1 8rem; height:8px; border:2px solid var(--line); position:relative;}
.jn-gbar i{position:absolute; left:0; top:0; bottom:0; background:var(--accent);}
.jn-grecent{display:flex; gap:3px;}
.jn-grecent i{display:block; width:12px; height:12px; border:2px solid var(--line);}
.jn-grecent i.part{background:#5a2021; border-color:#5a2021;}
.jn-grecent i.met{background:var(--accent); border-color:var(--accent);}
.jn-gacts{display:flex; align-items:center; gap:.6rem; margin-top:.4rem;}
.jn-gline{font-size:.74rem; padding:.3rem 0; border-bottom:2px solid var(--line);}
.jn-gform{border:2px solid var(--fg); padding:1rem;}
.jn-grid{display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:.8rem;}
.jn-msg{color:var(--accent); font-size:.7rem; min-height:1em; margin:.2rem 0 .6rem;}
.jn-search{flex:1 1 16rem; max-width:24rem; font-family:inherit; font-size:.76rem; border:2px solid var(--line); padding:.4rem .5rem;}
.jn-tl{display:flex; flex-direction:column;}
.jn-tlm{font-size:.6rem; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); margin:1.2rem 0 .3rem;}
.jn-tli{display:flex; gap:.8rem; align-items:flex-start; width:100%; background:transparent; border:none; border-left:2px solid var(--line); color:var(--fg); font:inherit; text-align:left;
  padding:.5rem .7rem; cursor:pointer;}
.jn-tli:hover{background:#151515;}
.jn-tli.k-milestone{border-left-color:var(--accent);}
.jn-tli.k-realization{border-left-color:var(--fg);}
.jn-tli.k-week, .jn-tli.k-month{border-left-color:#555;}
.jn-tld{flex:0 0 1.6rem; font-size:.9rem; font-weight:700; color:var(--muted); text-align:right;}
.jn-tlb{display:flex; flex-direction:column; gap:.15rem; min-width:0;}
.jn-tlb b{font-size:.74rem; letter-spacing:.06em; text-transform:uppercase; display:flex; align-items:center; gap:.4rem;}
.jn-tlb small{font-family:var(--sans); font-size:.8rem; color:#c2c2c2; line-height:1.5;}
.jn-kind{font-size:.54rem; letter-spacing:.12em; color:var(--muted); border:2px solid var(--line); padding:0 .3rem; font-weight:400;}
.jn-mdot{display:inline-block; width:9px; height:9px;}
.jn-mdot.m1{background:#2a2a2a;} .jn-mdot.m2{background:#3a2020;} .jn-mdot.m3{background:#5a2021;} .jn-mdot.m4{background:#9a3133;} .jn-mdot.m5{background:var(--accent);}
.jn-star{color:var(--accent); font-weight:400;}
.jn-plain{margin:0 0 .6rem; padding-left:1.1rem; font-size:.8rem; font-family:var(--sans); line-height:1.6;}
.jn-barr{display:flex; gap:.4rem; align-items:center;}
.jn-shl{display:inline-flex; align-items:center; gap:.6rem; flex-wrap:wrap;}
.jn-ev{background:transparent; border:1px solid var(--line); color:var(--muted); font:inherit; font-size:.52rem; letter-spacing:.1em; text-transform:uppercase;
  padding:.05rem .35rem; cursor:pointer; font-weight:400; vertical-align:middle;}
.jn-ev:hover{color:var(--fg); border-color:var(--muted);}
.jn-ev.k-R{border-color:#6a6a6a; color:#c9c9c9;}
.jn-ev.k-X{border-style:dashed;}
.jn-llab .jn-ev{margin-left:.4rem; text-transform:uppercase;}
.jn-plan{font-family:var(--sans); font-size:.9rem; line-height:1.6; border-left:2px solid var(--accent); padding:.4rem .7rem; margin:.4rem 0 0;}
.jn-plan .jn-llab{margin:0 0 .2rem;}
.jn-gplan{font-size:.82rem; margin:.4rem 0;}
.jn-exrow{align-items:center; margin:.2rem 0 .4rem;}
.jn-exsaved summary{cursor:pointer; color:var(--muted); font-size:.68rem; letter-spacing:.06em;}
.jn-extext{white-space:pre-wrap; font-family:var(--sans); font-size:.86rem; line-height:1.7; padding:.6rem .8rem; border-left:2px solid var(--line); margin-top:.4rem;}
.jn-exbar{align-items:center; margin:.2rem 0 .8rem;}
.jn-clock{font-size:1.1rem; letter-spacing:.06em; min-width:8rem;}
.jn-clock.done{color:var(--accent);}
.jn-exta{min-height:22rem; font-size:.95rem; line-height:1.8;}
.jn-trs{display:flex; flex-direction:column; gap:.7rem; align-items:flex-start;}
.jn-tr{border:2px solid var(--line); padding:.8rem .9rem .2rem; width:100%;}
.jn-tr .jn-q{margin-bottom:.6rem;}
.jn-care{border:2px solid var(--line); border-left:4px solid var(--fg); padding:.8rem 1rem; margin-bottom:1.4rem; font-size:.8rem; line-height:1.65;}
.jn-care p{margin:.2rem 0 0; font-family:var(--sans);}
.jn-care .jn-llab{margin:0;}
.jn-disclaim b{font-size:.7rem; letter-spacing:.12em; text-transform:uppercase;}
.jn-evlist{display:flex; flex-direction:column; gap:.2rem;}
.jn-evitem{border-left:2px solid var(--line); padding:.4rem .8rem .5rem;}
.jn-evitem b{display:block; font-size:.78rem;}
.jn-evitem small{display:block; font-size:.6rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:.15rem 0 .3rem;}
.jn-evitem p{margin:0; font-family:var(--sans); font-size:.84rem; line-height:1.65; color:#cfcfcf;}
.jn-evsec .jn-ev{cursor:default;}
@media (max-width:700px){
  .jn-two, .jn-grid{grid-template-columns:1fr; gap:.6rem;}
  .jn-slabel{flex-basis:100%;}
  .jn-dot{width:2.4rem; height:2.4rem;}
}
`;
var style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

window.Journal = { normalize:normalize, fresh:fresh, hasData:hasData, mount:mount,
  _test:{ normDay:normDay, dayHas:dayHas, periodStats:periodStats, words:words } };
})();
