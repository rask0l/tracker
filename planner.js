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
var FIELDS = ["title", "area", "sub", "start", "end", "allDay", "prio", "notes", "due"];
var DOW = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
var DAYNAME = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
var MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
var PRIO = ["", "!", "!!", "!!!"];
var PRIO_NAME = ["none", "low", "medium", "high"];
var DAWN = 240;         // 4:00: a block starting after midnight but before this is late night, not early
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
// "45m", "2h", "4h 45m": exact, for planned time
function hm2(min){ min = Math.round(min); var h0 = Math.floor(min / 60), m0 = min % 60; return h0 ? h0 + "h" + (m0 ? " " + m0 + "m" : "") : m0 ? m0 + "m" : "0h"; }
function hrs(min){ var x = Math.round(min / 6) / 10; return (x % 1 ? x.toFixed(1) : String(x)) + "h"; }
function num(x){ x = Math.round(x * 10) / 10; return x % 1 ? x.toFixed(1) : String(x); }
function mins(it){ return it.start == null ? 0 : it.end - it.start; }
function isFlex(it){ return it.area === "work" && it.sub === "flex"; }
// flex windows and all-day items (a trip, an exam day) are context, not tasks:
// no checkbox, never counted as done, planned, overdue or for the streak
function notTask(it){ return isFlex(it) || !!it.allDay; }
function normTime(v){ return Number.isInteger(v) && v >= 0 && v <= 1440 ? v : null; }

// ---------- data ----------
function normFields(o, t){
  o.title = str(t.title, 120).trim() || "untitled";
  o.area = AREAS.indexOf(t.area) >= 0 ? t.area : "personal";
  o.sub = SUBS[o.area].indexOf(t.sub) >= 0 ? t.sub : "";
  var s = normTime(t.start), e = normTime(t.end);
  if(s != null && e != null && e > s){ o.start = s; o.end = e; } else { o.start = null; o.end = null; }
  if(t.allDay === true){ o.allDay = true; o.start = null; o.end = null; }
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
    maxHours:(Number.isInteger(s.maxHours) && s.maxHours >= 1 && s.maxHours <= 24) ? s.maxHours : 12,
    // what the quests lean toward: CWES by default
    focus:["cwes", "side", "gym", "balanced"].indexOf(s.focus) >= 0 ? s.focus : "cwes",
    // flexible: quests only ask for outcomes (time, days, early starts); structured adds labs, theory, topics, long blocks
    questStyle:s.questStyle === "structured" ? "structured" : "flexible",
    dayMode:s.dayMode === "list" ? "list" : "timeline",
    weekStart:(Number.isInteger(s.weekStart) && s.weekStart >= 0 && s.weekStart <= 6) ? s.weekStart : 0 };

  var ids = {};
  out.acts = arr(x.acts).filter(function(t){ return t && typeof t === "object" && isDate(t.date); }).map(function(t){
    var o = normFields({ id:str(t.id || rid(), 40), date:t.date, done:!!t.done,
      createdAt:Number.isInteger(t.createdAt) && t.createdAt > 0 ? t.createdAt : 0 }, t);
    if(t.ruleId && isDate(t.ruleDate)){ o.ruleId = str(t.ruleId, 40); o.ruleDate = t.ruleDate; }
    // an all-day item can run over several days (a trip): up to 60
    if(o.allDay && isDate(t.to) && t.to > o.date && t.to <= addDays(o.date, 60)) o.to = t.to;
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
  // a running timer: { title, area, sub, at (epoch ms) }; it syncs like everything else
  var tm = obj(x.timer);
  out.timer = (typeof tm.at === "number" && tm.at > 0 && tm.at <= Date.now() + 864e5)
    ? normTimer(tm) : null;
  // the game: XP, levels, bosses and badges are worked out from what you finished;
  // only today's quest picks, the last level seen and when badges unlocked are kept
  out.game = normGame(x.game);
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

// ---------- game helpers ----------
var BOSSES = ["the procrastinator", "doomscroll hydra", "the snooze golem", "scope creep", "the imposter wraith",
  "the excuse goblin", "burnout lich", "the five-more-minutes demon", "context-switch swarm", "the comfort zone"];
function hash(str){
  var h = 2166136261;
  for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// level L is reached at 50*(L-1)*L XP: 100 for level 2, 300 for 3, 600 for 4...
function levelOf(xp){ var L = 1; while(50 * L * (L + 1) <= xp) L++; return L; }
function lvlBase(L){ return 50 * (L - 1) * L; }

// the game record (one for the whole site, on the root state; old copies on planner pages are kept but unused)
function normGame(gIn){
  var g = obj(gIn);
  var o = { off:!!g.off, loud:g.loud !== false, mute:!!g.mute, pageMade:!!g.pageMade, achv:(Number.isInteger(g.achv) && g.achv > 0) ? g.achv : 1,
    level:(Number.isInteger(g.level) && g.level > 0) ? g.level : 0, seen:{}, quests:{} };
  // real rewards you set yourself, bought with coins (1 coin per 10 xp)
  var okCost = function(c){ return Number.isInteger(c) && c >= 1 && c <= 100000; };
  o.rewards = (Array.isArray(g.rewards) ? g.rewards : [["movie night", 100], ["favourite meal out", 250], ["new gear you've wanted", 1000]]
    .map(function(r){ return { name:r[0], cost:r[1] }; })).filter(function(r){ return r && typeof r.name === "string" && r.name.trim() && okCost(r.cost); })
    .slice(0, 50).map(function(r){ return { id:str(r.id || rid(), 40), name:str(r.name.trim(), 60), cost:r.cost }; });
  o.claims = arr(g.claims).filter(function(c){ return c && typeof c.name === "string" && okCost(c.cost) && isDate(c.date); })
    .slice(-500).map(function(c){ return { id:str(c.id || rid(), 40), name:str(c.name, 60), cost:c.cost, date:c.date }; });
  Object.keys(obj(g.seen)).forEach(function(k){ if(/^[a-z0-9_]{1,30}$/.test(k) && isDate(g.seen[k])) o.seen[k] = g.seen[k]; });
  // every day's picks are kept: past quest XP is worked out from them, so trimming would take XP away
  Object.keys(obj(g.quests)).filter(isDate).sort().slice(-3000).forEach(function(d){
    if(Array.isArray(g.quests[d])) o.quests[d] = g.quests[d].filter(function(q){ return typeof q === "string" && /^[a-z0-9_.:]{1,48}$/.test(q); }).slice(0, 3);
  });
  // weekly quests, by the week's first day
  o.wquests = {};
  Object.keys(obj(g.wquests)).filter(isDate).sort().slice(-500).forEach(function(d){
    if(Array.isArray(g.wquests[d])) o.wquests[d] = g.wquests[d].filter(function(q){ return typeof q === "string" && /^[a-z0-9_.:]{1,48}$/.test(q); }).slice(0, 3);
  });
  // quests that more work could undo ("clear the day") stay won once won: { date:[ids] }
  o.qwon = {};
  Object.keys(obj(g.qwon)).filter(isDate).sort().slice(-3000).forEach(function(d){
    if(Array.isArray(g.qwon[d])) o.qwon[d] = g.qwon[d].filter(function(q){ return typeof q === "string" && /^[a-z0-9_.:]{1,48}$/.test(q); }).slice(0, 6);
  });
  return o;
}
// the first time the site-wide record is made, fold in what each planner page had
function mergeGames(list){
  list = list.filter(Boolean).map(normGame);
  if(!list.length) return normGame({});
  var m = normGame(list[0]), names = {}, ids = {};
  m.rewards.forEach(function(r){ names[r.name.toLowerCase()] = 1; });
  m.claims.forEach(function(c){ ids[c.id] = 1; });
  list.slice(1).forEach(function(g){
    m.level = Math.max(m.level, g.level); m.achv = Math.max(m.achv, g.achv);
    Object.keys(g.seen).forEach(function(k){ if(!m.seen[k] || g.seen[k] < m.seen[k]) m.seen[k] = g.seen[k]; });
    g.rewards.forEach(function(r){ if(!names[r.name.toLowerCase()]){ names[r.name.toLowerCase()] = 1; m.rewards.push(r); } });
    g.claims.forEach(function(c){ if(!ids[c.id]){ ids[c.id] = 1; m.claims.push(c); } });
  });
  m.claims.sort(function(x, y){ return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
  return m;
}

function normTimer(t){
  var f = normFields({}, { title:t.title, area:t.area, sub:t.sub === "flex" ? "" : t.sub });
  return { title:f.title, area:f.area, sub:f.sub, at:Math.round(t.at) };
}

// ---------- quick log: one line of text -> an activity ----------
// "gym 1h", "cwes lab 18:00-19:30 sqli", "side 45m landing page", "email boss",
// "6-7pm push day", "standup 9:15 15m done", "tomorrow cwes 2h plan".
// Area keys (work, gym, cwes, side, personal or an area's own name) are taken
// out of the title; hint words (study, run, client...) pick the area but stay.
var AREA_HINTS = {
  work:["job", "office", "meeting", "standup"],
  gym:["workout", "lift", "lifting", "run", "running", "cardio", "strength", "mobility"],
  cwes:["study", "htb", "hackthebox", "sqli", "xss", "ssrf", "idor", "lfi", "burp", "lab", "theory", "revision", "module"],
  side:["hustle", "client", "clients", "landing", "marketing", "monetize", "sales", "idea", "research", "build"]
};
function clock(hh, mm, mer){
  hh = +hh; mm = +(mm || 0);
  if(mm > 59) return null;
  if(mer){ if(hh < 1 || hh > 12) return null; if(mer === "pm" && hh < 12) hh += 12; if(mer === "am" && hh === 12) hh = 0; }
  else if(hh > 24) return null;
  var v = hh * 60 + mm;
  return v <= 1440 ? v : null;
}
function parseQuick(text, P, baseDate, now, plan){
  var raw = String(text || "").trim();
  if(!raw) return null;
  var t = " " + raw.toLowerCase()
    .replace(/\ball[ -]?day\b/g, "allday")
    .replace(/(\d)\s+(am|pm)\b/g, "$1$2")
    .replace(/(\d(?::\d{2})?(?:am|pm)?)\s*(?:-|–|—|\bto\b)\s*(\d)/g, "$1-$2")
    .replace(/(\d)\s+(h|hrs?|hours?|m|mins?|minutes?)\b/g, "$1$2") + " ";
  var area = null;
  // multi-word area names ("side hustle", "cwes study") count as one key
  FOCUS.forEach(function(a){
    var n = P.areas[a].name.toLowerCase();
    if(n.indexOf(" ") > 0 && t.indexOf(" " + n + " ") >= 0){ if(!area) area = a; t = t.replace(" " + n + " ", " "); }
  });
  var q = { date:baseDate, start:null, end:null, dur:0, done:null, prio:0, hadTime:false, guessed:false }, words = [], allw = [], sub = "", hintArea = null;
  t.trim().split(/\s+/).forEach(function(w){
    var m, k = w.replace(/[,.;]+$/, "");
    if((m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?-(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(k))){
      var m1 = m[3] || m[6], m2 = m[6] || m[3];
      // "11-1pm" is 11am to 1pm: a start later than the end flips its am/pm
      if(!m[3] && m[6] && +m[1] > +m[4] && +m[1] !== 12) m1 = m[6] === "pm" ? "am" : "pm";
      var a1 = +m[1], a2 = +m[4];
      if(!m1 && a1 >= 1 && a1 <= 6 && m[1].charAt(0) !== "0"){ a1 += 12; q.guessed = true; }
      if(!m2 && a2 >= 1 && a2 <= 7 && a1 >= 12 && m[4].charAt(0) !== "0"){ a2 += 12; }
      var s1 = clock(m1 ? m[1] : a1, m[2], m1), s2 = clock(m2 ? m[4] : a2, m[5], m2);
      if(s1 != null && s2 != null && s2 <= s1 && s2 + 720 <= 1440) s2 += 720;
      if(s1 != null && s2 != null && s2 > s1){ q.start = s1; q.end = s2; q.hadTime = true; return; }
    }else if((m = /^(\d{1,2}):(\d{2})(am|pm)?$/.exec(k)) || (m = /^(\d{1,2})()(am|pm)$/.exec(k))){
      var hh = +m[1];
      if(!m[3] && hh >= 1 && hh <= 6 && m[1].charAt(0) !== "0"){ hh += 12; q.guessed = true; }
      var c = clock(m[3] ? m[1] : hh, m[2], m[3]);
      if(c != null && c < 1440){ q.start = c; q.hadTime = true; return; }
    }else if((m = /^(\d+(?:\.\d+)?)(h|hr|hrs|hour|hours)$/.exec(k))){ q.dur = Math.round(+m[1] * 60); return; }
    else if((m = /^(\d+)(m|min|mins|minute|minutes)$/.exec(k))){ q.dur = +m[1]; return; }
    else if((m = /^(\d+)h(\d{1,2})m?$/.exec(k))){ q.dur = +m[1] * 60 + +m[2]; return; }
    if(k === "today"){ q.date = today(); return; }
    if(k === "tomorrow" || k === "tmr" || k === "tmrw"){ q.date = addDays(today(), 1); return; }
    if(k === "yesterday"){ q.date = addDays(today(), -1); return; }
    if(k === "done" || k === "did" || k === "✓"){ q.done = true; q.explicitDone = true; return; }
    if(k === "allday"){ q.allDay = true; return; }
    if(k === "plan" || k === "todo" || k === "later"){ q.done = false; return; }
    if(/^!{1,3}$/.test(k)){ q.prio = k.length; return; }
    if((k === "at" || k === "for" || k === "from") ) { words.push(w); allw.push(w); return; }
    var key = AREAS.filter(function(a){ return k === a || (a !== "personal" && k === P.areas[a].name.toLowerCase()); })[0];
    if(key){ if(!area) area = key; allw.push(w); return; }
    if(!hintArea) FOCUS.forEach(function(a){ if(!hintArea && AREA_HINTS[a].indexOf(k) >= 0) hintArea = a; });
    if(!sub) Object.keys(SUBS).forEach(function(a){ if(!sub && SUBS[a].indexOf(k) >= 0 && k !== "flex") sub = a + ":" + k; });
    words.push(w); allw.push(w);
  });
  // filler words only make sense next to a time
  var filler = function(w){ return !(/^(at|for|from)$/.test(w) && (q.hadTime || q.dur)); };
  words = words.filter(filler); allw = allw.filter(filler);
  // "core work" stays "core work": if only a type word is left, keep the area word too
  var isSub = function(w){ return Object.keys(SUBS).some(function(a){ return SUBS[a].indexOf(w.replace(/[,.;]+$/, "")) >= 0; }); };
  if(words.length && words.every(isSub) && allw.length > words.length) words = allw;
  q.area = area || hintArea || (sub ? sub.split(":")[0] : "personal");
  q.sub = sub && sub.split(":")[0] === q.area ? sub.split(":")[1] : "";
  // keep the user's own capitals for the title
  var keep = raw.split(/\s+/), title = [];
  words.forEach(function(w){
    for(var i = 0; i < keep.length; i++) if(keep[i].toLowerCase().replace(/[,.;]+$/, "") === w.replace(/[,.;]+$/, "")){ title.push(keep[i]); keep.splice(i, 1); return; }
    title.push(w);
  });
  q.title = title.join(" ").trim();
  q.autoTitle = !q.title;
  if(!q.title) q.title = (q.area === "personal" ? "personal" : P.areas[q.area].name) + (q.sub ? " " + q.sub : "");
  if(q.allDay){ q.start = null; q.end = null; q.dur = 0; q.hadTime = false; q.done = false; return q; }
  // times: a range, a start (+ length), or a length that ended just now
  if(q.start != null && q.end == null) q.end = Math.min(1440, q.start + (q.dur || 60));
  // planning a whole day: a bare length is placed after the line before it, by the caller
  if(plan){ q.done = !!q.explicitDone; return q; }
  if(q.start == null && q.dur){
    var end = q.date === today() ? Math.floor(now / 5) * 5 : P.settings.dayEnd;
    q.end = Math.max(q.dur, end); q.start = q.end - q.dur;
  }
  if(q.done === null){
    // a length with no clock time is something you just did; a past time range is a log too
    if(q.dur && !q.hadTime) q.done = true;
    else if(q.start != null) q.done = q.date < today() || (q.date === today() && q.start <= now);
    else q.done = false;
  }
  return q;
}

// ---------- occurrences (shared by the page and by index.html's streak link) ----------
function indexOf(P){
  var ix = { byDate:{}, over:{}, spans:[] };
  P.acts.forEach(function(a){
    if(a.to) ix.spans.push(a);
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
  ix.spans.forEach(function(a){ if(a.date < date && date <= a.to) out.push(a); });
  P.rules.forEach(function(r){ if(occurs(r, date) && !ix.over[r.id + "|" + date]) out.push(virt(r, date)); });
  return out.sort(byTime);
}
// a day counts for the linked streak when something was planned and enough of it is done
function countsFor(P, items){
  var total = 0, done = 0;
  items.forEach(function(it){ if(!notTask(it)){ total++; if(it.done) done++; } });
  if(!total) return false;
  return P.streak.rule === "pct" ? done * 100 >= total * P.streak.pct : done === total;
}
function countDays(P, dates){
  var ix = indexOf(P);
  return dates.map(function(d){ return isDate(d) && countsFor(P, itemsFor(P, ix, d)); });
}
// the day's plan for a tracker's Day card (flex windows left out)
var AREA_COLOR = { work:"#8a8a8a", gym:"#e5484b", cwes:"#4f8fe8", side:"#cc6f16", personal:"#4a4a4a" };
function dayItems(P, date){
  return itemsFor(P, indexOf(P), date).filter(function(it){ return !isFlex(it); }).map(function(it){
    return { key:it.virtual ? it.key : it.id, title:it.title, done:!!it.done, allDay:!!it.allDay, color:AREA_COLOR[it.area] || "#4a4a4a",
             time:it.allDay ? "all day" : it.start != null ? hm(it.start) + "–" + hm(it.end) : "" };
  });
}
// tick or untick one of them; a repeating occurrence is saved as its own activity first
function tick(P, date, key){
  var it = itemsFor(P, indexOf(P), date).filter(function(x){ return (x.virtual ? x.key : x.id) === key; })[0];
  if(!it || notTask(it)) return false;
  if(it.virtual){
    var a = { id:rid(), date:it.date, done:false, createdAt:Date.now(), ruleId:it.ruleId, ruleDate:it.ruleDate };
    FIELDS.forEach(function(k){ if(it[k] !== undefined) a[k] = it[k]; });
    delete a.due;
    P.acts.push(a); it = a;
  }
  it.done = !it.done;
  return true;
}
// one line for the tracker's Day card: "4/5 done · cwes study 2h · gym ✓"
function daySummary(P, date){
  var items = itemsFor(P, indexOf(P), date), total = 0, done = 0, by = {};
  items.forEach(function(it){
    if(notTask(it)) return;
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
var timerTick = null; // the running timer's 1s repaint
var nowTick = null;   // the NOW panel's countdown, refreshed every 30s
var activePl = null;  // the planner on screen gets the single-key shortcuts
// the quests last drawn while today's weren't saved yet: the first change saves exactly these,
// so making a change never swaps the quests you were looking at
var SHOWN = { date:"", sig:"", daily:null, mon:"", weekly:null };
function noteShown(G){
  if(!G || !G.todayQ) return;
  var ids = function(l){ return l.map(function(q){ return q.id; }); };
  SHOWN = { date:today(), sig:G.qSig || "", daily:G.qFresh && G.qFresh.daily && G.todayQ.length ? ids(G.todayQ) : null,
    mon:G.thisMon || "", weekly:G.qFresh && G.qFresh.weekly && G.weekQ.length ? ids(G.weekQ) : null };
}
// save today's and this week's picks into the game record, and remember kept wins.
// Returns { picks, any }: picks = the saved quest ids changed (scores must be redone)
function lockQuests(g, G){
  var r = { picks:false, any:false };
  if(!g || !G || !G.todayQ) return r;
  var t = today(), same = SHOWN.date === t && SHOWN.sig === (G.qSig || "");
  if(!g.quests) g.quests = {};
  if(!g.wquests) g.wquests = {};
  if(!g.qwon) g.qwon = {};
  if(!g.quests[t] || (G.qFresh && G.qFresh.daily)){
    var ids = same && SHOWN.daily ? SHOWN.daily : G.todayQ.map(function(q){ return q.id; });
    if(ids.length && String(g.quests[t] || "") !== String(ids)){ g.quests[t] = ids.slice(); r.picks = r.any = true; }
  }
  var wm = G.thisMon;
  if(wm && (!g.wquests[wm] || (G.qFresh && G.qFresh.weekly)) && G.weekQ.length){
    var w = same && SHOWN.mon === wm && SHOWN.weekly ? SHOWN.weekly : G.weekQ.map(function(q){ return q.id; });
    if(String(g.wquests[wm] || "") !== String(w)){ g.wquests[wm] = w.slice(); r.picks = r.any = true; }
  }
  if(!r.picks) G.todayQ.forEach(function(q){
    if(!q.keep || !q.live) return;
    var l = g.qwon[t] || (g.qwon[t] = []);
    if(l.indexOf(q.id) < 0){ l.push(q.id); r.any = true; }
  });
  return r;
}
// does the game record still need today's picks saved? cheap, no scoring. index.html asks
// on every save, so this must stay cheap: it only says yes for the first change of the day.
// Kept quest wins are saved where planner items change (the planner's gameStep, the Day card).
function needsLock(g){
  if(!g || g.off) return false;
  return !(g.quests || {})[today()];
}
document.addEventListener("keydown", function(e){
  if(!activePl || !activePl.root.isConnected || activePl.root.offsetParent === null) return;
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  var tg = e.target;
  if(tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable)) return;
  if(document.querySelector(".pl-cele:not([hidden])")) return;
  // the site's menus and popups (the "/" page menu filters as you type) own the keys while open
  if(document.querySelector(".page-menu, .slash, .new-pop, .icon-pop, .sync-pop, .font-pop")) return;
  activePl.key(e);
});
// --- pixel emblems: 8x8 icons drawn as SVG in currentColor, so they use the site's colours ---
var PIX = {
  drop:["...#....","...#....","..###...","..###...",".#####..",".#####..","..###...","........"],
  check:["........","......##",".....##.","#...##..","##.##...",".###....","..#.....","........"],
  flame:["....#...","...##...","..###.#.","..#####.",".######.",".##.###.",".#...##.","..###..."],
  infinity:["........","........",".##..##.","#..##..#","#..##..#",".##..##.","........","........"],
  calendar:[".#....#.","########","#......#","#.#.#..#","#......#","#.#.#..#","#......#","########"],
  skull:["..####..",".######.","#..##..#","#..##..#","########",".###.##.","..#.#.#.","..#.#.#."],
  bug:["#......#",".#.##.#.","..####..","#.####.#",".######.","#.####.#","..####..",".#....#."],
  terminal:["########","#......#","#.#....#","#..#...#","#.#....#","#...##.#","#......#","########"],
  flask:["..###...","...#....","...#....","..#.#...",".#...#..","#.###.#.","#######.","........"],
  book:[".##..##.","#..##..#","#..##..#","#..##..#","#..##..#","#..##..#",".##..##.","........"],
  hammer:["#####...","#####...","..#.....","..#.....","..#.....","..#.....","..#.....","........"],
  bolt:["....##..","...##...","..##....",".######.","....##..","...##...","..##....",".#......"],
  rocket:["...##...","..####..","..#..#..","..####..","..####..",".######.","#.#..#.#","..#..#.."],
  castle:["#.#..#.#","########",".######.",".##..##.",".##..##.",".######.",".##..##.",".##..##."],
  coin:["..####..",".#....#.","#..##..#","#..#...#","#...#..#","#..##..#",".#....#.","..####.."],
  bulb:["..####..",".#....#.",".#....#.",".#....#.","..#..#..","..####..","..####..","...##..."],
  dumbbell:["........","##....##","##....##","########","##....##","##....##","........","........"],
  sword:["......##",".....###","....###.","#..###..",".####...","..##....",".#.#....","#......."],
  shield:["########","#......#","#..##..#","#.####.#","#..##..#",".#....#.","..#..#..","...##..."],
  scroll:["#######.","#.....#.","#.###.#.","#.....#.","#.###.#.","#.....##","#......#","########"],
  target:["..####..",".#....#.","#..##..#","#.#..#.#","#.#..#.#","#..##..#",".#....#.","..####.."],
  die:["########","#......#","#.#..#.#","#......#","#......#","#.#..#.#","#......#","########"],
  diamond:["...##...","..####..",".######.","########",".######.","..####..","...##...","........"],
  star:["...##...","...##...","########",".######.","..####..",".##..##.","##....##","........"],
  sun:["#..#..#.",".#.#.#..","..###...","#######.","..###...",".#.#.#..","#..#..#.","........"],
  eye:["........","..####..",".#....#.","#..##..#","#..##..#",".#....#.","..####..","........"],
  gift:["..#..#..","...##...","########","#..##..#","########","#..##..#","#..##..#","########"],
  trophy:["########","#.####.#",".######.","..####..","...##...","...##...","..####..",".######."],
  crown:["........","#..##..#","#..##..#","##.##.##","########","########","........","########"],
  chev1:["........","........","...##...","..#..#..",".#....#.","#......#","........","........"],
  chev2:["...##...","..#..#..",".#....#.","#..##..#","..#..#..",".#....#.","#......#","........"]
};
// Badge and rank icons: game-icons.net (https://game-icons.net) by Lorc, Delapouite and
// contributors, CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). Path data only,
// rounded; 512x512 viewBox; drawn in currentColor so they take the site's colours.
var GI = {
  "all-seeing-eye":"M18 18v15.8L179.4 215.4l9.5-16.4L28 18zm77.7 0l97 174.5l10.5-18.2L116.3 18zm91.2 0c4.3 19 15.3 67.2 28.4 125.3c0.6 2.5 1.1 4.8 1.6 7.3l13.3-23A55645 55645 0 0 0 205.3 18zM247 18v80.4l9-15.6l7.8 13.5L265 98.4V18zm59.8 0l-24.5 110.3l13.3 23.1L325.2 18zm88.9 0l-86.9 156.3l10.5 18.2L416.3 18h-20.6zm88.3 0L323.1 199l9.5 16.4L494 33.8V18zM18 98.2v22.5l150.8 113.1l9.1-15.7zm476 0L334.1 218.1l9.1 15.7L494 120.8zm-238 20.5l-74.7 129.3c20.3-9.1 46.3-14.3 74.7-14.3s54.4 5.2 74.7 14.3zm-238 70.3v19.2l136.1 51l9.1-15.8L18 189.1zm476 0l-145.2 54.4l9.1 15.8L494 208.4v-19.2zM18 249.2v18.1l122.6 15.3l9.8-16.9zm476 0l-132.4 16.5l9.8 16.9L494 267.3zm-238 2.6c-14.7 0-26.5 11.8-26.5 26.5c0 8.5 3.9 16.1 10.1 20.9a28.1 28.1 0 0 1-1.4-8.6a28.1 28.1 0 0 1 28.1-28.1a28.1 28.1 0 0 1 13 3.2c-4.4-8.3-13.2-13.9-23.4-13.9zm-38.2 3.7c-12.7 2.6-23.9 6.3-33.1 10.9c-17.6 8.8-26.2 19.8-26.2 29.6s8.6 20.8 26.2 29.6s43.1 14.6 71.3 14.6s53.6-5.8 71.3-14.6s26.2-19.8 26.2-29.6s-8.6-20.8-26.2-29.6c-9.2-4.6-20.4-8.3-33.1-10.9a44.1 44.1 0 0 1 6.3 22.8c0 24.5-20 44.5-44.5 44.5s-44.5-20-44.5-44.5c0-8.3 2.3-16.1 6.3-22.8m-83.9 38.7L18 308.7v18.1l104.7-13.1zm244.1 0l11.3 19.6L494 326.8v-18.1zm-233.8 18.1l-57.1 98.9h337.6l-57.1-98.9c-5.8 12.1-17.7 22-32.4 29.4c-20.9 10.5-48.7 16.5-79.3 16.5s-58.4-6.1-79.3-16.5c-14.7-7.4-26.6-17.3-32.4-29.4zm255.8 20.1l14.2 24.5L494 386.9v-19.2l-93.9-35.2zm-288.3 0L18 367.6v19.2l79.7-29.9l14.2-24.5zm-31.6 54.8L18 426.1v21.2l43-26.9l19.2-33.2zm351.6 0l19.2 33.2L494 447.4v-21.2l-62.2-38.9zm-350.8 42L18 484.3V494h16.2l74-64.8H81zm42.2 0L67.6 494h23.7l55.5-64.8h-23.7zm41.8 0L127.9 494h20.7l37-64.8h-20.7zm42.8 0c-8.7 29-15.7 51.9-19.6 64.8h18.8a10720 10720 0 0 0 19.6-64.8h-18.8zm39.3 0V494h18v-64.8h-18zm40 0L305.5 494h18.7l-18.5-64.8h-18.7zm39.3 0L363.3 494h20.7l-37-64.8h-20.7zm38.9 0L420.7 494h23.7l-55.5-64.8H365.2zm38.5 0L477.8 494H494v-9.7l-63-55.1z",
  "angel-wings":"M92.4 29C75.3 47.7 60.8 69.7 49.6 94L167.5 204.7l-12.8 13.6L41.9 112.4c-9.2 24.3-15.4 50.5-18.2 77.8l116.2 58.7l-8.4 16.7L22.3 210.5c-1 24.4 0.8 49.7 5.4 75.2l100.5 8.3l-1.5 18.6l-95-7.8c0.7 3.1 1.5 6.2 2.3 9.3c4.4 16.5 9.9 32.3 16.4 47.4c8.8-1.6 17.8-3.3 27.8-5.2c26.8-5 53.1-10.1 53.1-10.1l3.5 18.3s-26.4 5.1-53.2 10.1c-8 1.5-15.8 3-23.2 4.3c8.7 17.5 18.6 33.9 29.7 49l60.8-34.3L158.2 410l-58.4 32.9c12.2 14.8 25.5 28.2 39.6 40l17.2-20.3c1.4-20.5 5-37.7 14.4-51.7c6.3-9.4 15.4-16.8 27.2-21.9C189.9 376.1 183.3 361.6 179 345.6c-14.5-54.1 0.6-108.5 36.4-138.1L92.4 29zm330.8 0L300.3 207.5c35.8 29.6 51 83.9 36.4 138.1c-4.3 15.9-10.8 30.2-18.9 43c12.3 5.4 21.6 13.5 27.5 23.7c7.8 13.3 10.5 29.1 11.4 47.5l19.6 23.2c14.1-11.8 27.4-25.2 39.6-40L357.5 410l9.2-16.3L427.5 428c11-15.1 21-31.5 29.7-49c-7.4-1.4-15.2-2.8-23.2-4.3c-26.8-5-53.2-10.1-53.2-10.1l3.5-18.3s26.4 5 53.1 10.1a8378 8378 0 0 0 27.8 5.2a357 357 0 0 0 16.4-47.5c0.8-3.1 1.6-6.2 2.3-9.3L389 312.6l-1.5-18.6l100.5-8.3c4.7-25.5 6.4-50.7 5.4-75.2L384.2 265.7l-8.4-16.7L492 190.2c-2.8-27.4-9-53.6-18.2-77.9L361 218.3l-12.8-13.6L466.1 94c-11.2-24.3-25.7-46.3-42.8-65zM256.1 290c-10.5 0-20.2 5.3-27.8 15.1c-7.6 9.8-12.7 23.9-12.7 39.7s5 29.9 12.7 39.7c7.6 9.8 17.3 15.2 27.8 15.2s20.1-5.4 27.8-15.2s12.7-23.9 12.7-39.7s-5-29.9-12.7-39.7s-17.3-15.1-27.8-15.1zm39.6 111.2c-10.4 11.1-24.2 18.3-39.6 18.3c-15 0-28.5-6.8-38.8-17.4c-2.7 0.7-5.1 1.4-7.4 2.2c-11.5 4-18.4 9.5-23.4 17c-9.2 13.7-11.5 37-11.9 69.2h163.8c-0.1-31.6-1.2-55.2-9.2-68.9c-4.4-7.5-10.6-12.9-21.6-17.1c-3.5-1.3-7.4-2.4-11.9-3.4z",
  "anvil":"M128.7 115.6v147.8h285v-147.8zm-111.8 20.5c17.4 47.1 54.4 80.4 94.9 93.8v-93.8zm414.4 12.3v88.7c21.5-9.1 42.9-25.3 64.4-47.4c-21.5-22.6-42.6-35.2-64.4-41.3zm-226.2 132.5c-12.2 38.5-33.9 71.5-60.6 100.5l257.8 0c-28.7-29-50-62.1-61.5-100.5H205zM101.8 400v43.8h337.6V400z",
  "aztec-calendar-sun":"m256 40.3l-42.7 102.4c6.5-2.1 13.3-3.8 20.2-4.9L256 92.8l22.5 45c6.9 1.1 13.7 2.8 20.2 4.9zm-85.7 49.8c-16.3 0.5-32.4 2.9-47.7 7.1c15.6 27.2 26.8 54.3 34.3 81.1c9.5-10 20.5-18.5 32.6-25.3l3-7.1c-7.8-21.2-16-42.5-22.2-55.9m171.4 0c-6.2 13.4-14.4 34.7-22.2 55.9l3 7.1c12.1 6.8 23.1 15.3 32.6 25.3c7.5-26.8 18.7-53.9 34.3-81.1c-15.3-4.3-31.4-6.7-47.7-7.1M105.2 103.1c-16.5 6.5-31.6 15.3-44.4 26.5c14.2 16.8 24.4 38 31.6 56c8.2 20.5 12.3 37.1 12.3 37.1l4.8 19l-17.5-8.8c-13.3-6.6-30.7-6.6-44 0c-13.3 6.7-23 19-23 40s9.7 33.3 23 40c13.3 6.6 30.7 6.6 44 0l16.4-8.3l-3.6 18.1s-4.1 20.5-12.3 45c-7.2 21.6-17.2 46.5-31.8 64.5c12.7 11.1 27.8 19.9 44.1 26.4c15.9-36.7 28.8-73.4 37-110c-14.4-21.7-22.8-47.7-22.8-75.7c0-28.7 8.8-55.3 23.9-77.3c-7.2-30.5-19.4-61.3-37.7-92.5m301.6 0c-18.3 31.2-30.5 62-37.7 92.5c15.1 22 23.9 48.6 23.9 77.3c0 28-8.4 54-22.8 75.7c8.2 36.6 21.1 73.3 37 110c16.3-6.5 31.4-15.3 44.1-26.4c-14.6-18-24.6-42.9-31.8-64.5c-8.2-24.5-12.3-45-12.3-45l-3.6-18.1l16.4 8.3c13.3 6.6 30.7 6.6 44 0c13.3-6.7 23-19 23-40s-9.7-33.3-23-40c-13.3-6.6-30.7-6.6-44 0l-17.5 8.8l4.8-19s4.1-16.6 12.3-37.1c7.2-18 17.4-39.2 31.6-56c-12.8-11.2-27.9-20-44.4-26.5M256 153.9c-65.8 0-119 53.2-119 119s53.2 119 119 119s119-53.2 119-119s-53.2-119-119-119m-89 62h82v9c0 11-5.2 20.9-12.6 28.4c-7.5 7.4-17.4 12.6-28.4 12.6s-20.9-5.2-28.4-12.6c-7.4-7.5-12.6-17.4-12.6-28.4zm96 0h82v9c0 11-5.2 20.9-12.6 28.4c-7.5 7.4-17.4 12.6-28.4 12.6s-20.9-5.2-28.4-12.6c-7.4-7.5-12.6-17.4-12.6-28.4zm-75.4 18c1.2 2.3 2.8 4.6 4.8 6.6c4.5 4.6 10.6 7.4 15.6 7.4s11.1-2.8 15.6-7.4c2-2 3.6-4.3 4.8-6.6zm96 0c1.2 2.3 2.8 4.6 4.8 6.6c4.5 4.6 10.6 7.4 15.6 7.4s11.1-2.8 15.6-7.4c2-2 3.6-4.3 4.8-6.6zM161.5 296l94.5 15.8l94.5-15.8l6.5 16.4l-101 67.3l-101-67.3zm38.4 24.7l56.1 37.4l56.1-37.4L256 330zm-44.1 45.5c-8.3 33.1-20 65.8-33.8 98.2c15.5 4.4 31.8 6.8 48.2 7.3c7.1-16.1 17.5-46.9 26.5-75.3c-15.5-7.4-29.4-17.7-40.9-30.2m200.4 0c-11.5 12.5-25.4 22.8-40.9 30.2c9 28.4 19.4 59.2 26.5 75.3c16.4-0.5 32.7-2.9 48.2-7.3c-13.8-32.4-25.5-65.1-33.8-98.2m-142.7 36.9c-3.2 10.1-6.5 20.4-9.8 30.3c3.5 3.4 8.8 6.6 15.8 9c7.9 2.8 17.5 4.5 27.5 5.2v-38c-11.6-0.8-22.9-3-33.5-6.5m85 0c-10.6 3.5-21.9 5.7-33.5 6.5v38c10-0.7 19.6-2.4 27.5-5.2c7-2.4 12.3-5.6 15.8-9c-3.3-9.9-6.6-20.2-9.8-30.3",
  "bloody-sword":"M35.1 35.8a16.3 16.3 0 0 0-14.6 8.2c-4.5 7.8-1.8 17.9 6 22.4c4.8 2.8 10.4 2.8 15.1 0.6l68.6 39.4l-29.8 52l28.5 16.5c6.4-49.5 27.9-90.2 68.7-119.8l-28.5-16.5l-29.6 51.7l-68.5-39.4c-0.4-5.2-3.3-10-8.1-12.8a16.2 16.2 0 0 0-7.7-2.2zm153.1 71.6l-37.9 0.6l251.5 144.7l-9.3 16.2l-253.4-145.9l19.9 35.1c3.9 1.9 29.9 14.4 59.8 33.9c30.7 20 64 45 74.4 74.7c4.6 2.3 31.5 15.5 69.6 27.8c38 12.2 84.1 21.7 119.9 15.6c-13-35.5-44.6-70.2-74.5-96c-27.7-24-52.1-39.7-59.1-44c-30.9 6-69.2-10.7-101.9-27.5c-31.6-16.3-55.3-32.7-58.9-35.2zm-27 72.9c5.6 17.4 10.4 39.6 14.5 64.6v77.3h18.7v-42.1c14.7-28.5 40.9-3.1 50.7 53.5v161h18.7V335.9c12.6-13.2 27.9 3.7 39 32.2v35.2h18.7v-25.7c17.1-20.7 46.4-5.7 59.9 49.1v66.9h18.7v-67.1c17.6-58.1 49.2-84.4 74.4-96.3c-38.7 3.8-81.7-6.3-117.5-17.8c-43-13.8-75.7-30.4-75.7-30.4l-3.7-1.9l-1.1-4c-5.5-20.4-37-48.1-68-68.2c-18.3-11.9-35.8-21.5-47.3-27.5zm23.9 181.5c-11.6 0-21.1 9.4-21.1 21.1c0 11.6 9.4 21.1 21.1 21.1s21.1-9.4 21.1-21.1c0-11.6-9.4-21.1-21.1-21.1m283.8 7.5s-21.1 52.7-21.1 64.3s9.4 21.1 21.1 21.1s21.1-9.4 21.1-21.1s-21.1-64.3-21.1-64.3M312.1 426.1c-11.6 0-21.1 9.4-21.1 21.1c0 11.6 9.4 21.1 21.1 21.1s21.1-9.4 21.1-21.1c0-11.6-9.4-21.1-21.1-21.1",
  "bordered-shield":"M50.8 26.3c-1.1 42.9 3 85.9 12 128.6l50.6-11.4c-2.7-19.5-4.1-39.3-3.6-59l0.2-9.1h49.4V26.3zm306.6 0v49.1h45.9l0.2 9.1a381.4 381.4 0 0 1-3.1 59l50.1 11.3c9-42.6 13.1-85.6 12-128.5H357.4zm-131.7 1.4v45.8h65.1V27.6h-65.1zM178.1 43.3V94h-49.6c0.1 18.3 1.7 36.8 4.6 55.2l1.3 8.6l-50.2 11.3a525 525 0 0 0 11.2 40.7l41.1-6.2l50.8 107.1l-31.7 28.5a647 647 0 0 0 22.6 34l42.5-31.5l5.6 6.9c9.7 11.8 19.9 23.6 30.8 34.9c10.9-11.3 21.1-22.6 30.7-34.3l5.6-6.9l41.8 30.9a650 650 0 0 0 22.8-34.3l-31.4-28.1l50.8-107.1l40.6 6.1a526 526 0 0 0 11.2-40.7l-49.6-11.2l1.3-8.6c2.9-18.3 4.1-36.8 4-55.2h-46.2V43.3h-29.2v48.8h-102.4v-48.8h-29zm-13.9 79.3h185.4l0.2 9.1c1.7 73-27.9 138-86.1 199.9l-6.8 7.2l-6.8-7.2c-58.6-62.1-87.9-127-86.1-199.9l0.2-9.1zm18.5 18.7c0.8 61.2 25.1 115.6 74.2 170.1c48.9-54.3 73.4-108.9 74.2-170.1zm-57.2 82.9l-54.2 8.2l52.3 110.3l40.8-36.6l-38.9-81.9zm262.8 0l-38.9 81.9l40.8 36.6L442.5 232.4zM217.5 367.2l-42.7 31.6c23.9 32.7 51.3 64.5 82.2 95.2c30.7-30.7 57.7-62.4 81.5-95.2l-42.1-31.1c-10.3 12.2-21 24.2-32.8 36l-6.6 6.6l-6.6-6.6c-11.9-11.9-22.6-24.2-32.8-36.5z",
  "boss-key":"M256 20.5L242.7 60.3c4.3-0.5 8.8-0.8 13.3-0.8s8.9 0.3 13.3 0.8zM148.7 28.1C55.5 47.1-4.3 183.5 158.4 200.9a101.2 101.2 0 0 1-7.4-38.1c0-15.2 3.3-29.6 9.3-42.5c-56.6-23.7-61-55.1-11.7-92.2zm214.6 0c49.4 37 44.9 68.4-11.6 92.2a101.2 101.2 0 0 1 9.3 42.5c0 13.5-2.6 26.3-7.4 38.1c162.7-17.5 102.9-153.8 9.7-172.8zM256 77.5c-48.2 0-87 38.2-87 85.3c0 47.1 38.8 85.3 87 85.3c48.2 0 87-38.2 87-85.3s-38.8-85.3-87-85.3m-9 23h18v7.8c14.7 2.5 26.3 10.8 35.4 19.9c10.8 10.8 19.1 23.1 26 30l6.4 6.4l-6.4 6.4c-6.9 6.9-15.2 19.2-26 30c-9.1 9.1-20.7 17.4-35.4 19.9v7.8h-18v-7.8c-14.7-2.5-26.3-10.8-35.4-19.9c-10.8-10.8-19.1-23.1-26-30l-6.4-6.4l6.4-6.4c6.9-6.9 15.2-19.2 26-30c9.1-9.1 20.7-17.4 35.4-19.9zm0 26.1c-8.6 2.2-15.7 7.4-22.6 14.3c-7.1 7.1-13.5 15.8-20.2 23.6c6.7 7.8 13.1 16.5 20.2 23.6c6.9 6.9 14 12.1 22.6 14.3v-7c-13.3-3.9-23.2-16.3-23.2-30.9s9.9-27 23.2-30.9zm18 0v7c13.3 3.9 23.2 16.3 23.2 30.9s-9.9 27-23.2 30.9v7c8.6-2.2 15.7-7.4 22.6-14.3c7.1-7.1 13.5-15.8 20.2-23.6c-6.7-7.8-13.1-16.5-20.2-23.6c-6.9-6.9-14-12.1-22.6-14.3zm-9 23.7c-7.9 0-14.2 6.2-14.2 14.2s6.3 14.2 14.2 14.2c8 0 14.2-6.3 14.2-14.2s-6.2-14.2-14.2-14.2zm-23 113.3V299.5h46v-35.9a106.6 106.6 0 0 1-23 2.5c-7.9 0-15.6-0.9-23-2.5m9.4 53.9v164.9c1.4 2.7 5.6 9.1 13.6 9.1c7.9 0 12.4-6.4 14.1-9.2l0-164.8H242.4zm45.7 78l0 18h31.9v-18zm0 32l0 18h15.9v-18H288.1zm0 32l0 18h31.9v-18H288.1z",
  "brain":"M241.1 54.4a294 294 0 0 0-12.3 0.3c-8.8 1.6-12.9 5.4-15.1 9.8c-2.4 4.9-2.3 11.4 0.4 17.2c2.7 5.8 7.7 10.6 14.7 12.4c7 1.8 16.5 0.9 29.1-7.2l10.1 15.8c-15.8 10.1-31.1 12.8-43.8 9.5c-12.7-3.2-22.1-12.1-27-22.6c-4.6-9.8-5.4-21.4-1-31.6c-42.9 6.9-81.8 23.4-111.6 46.6c-9.8 10.7-10.8 23.1-6.5 31.6c4.8 9.5 16.2 16.5 39 9.3l5.7 17.8c-28.6 9-52.1-0.6-61.3-18.6c-2.2-4.4-3.6-9.2-4.1-14.1c-4.8 5.7-9.2 11.7-13 17.8l0.1 0.1c-8.6 19.6-8.8 33.2-5.4 42c3.4 8.8 10.6 14.4 21.7 17.5c22.2 6.2 58.1-1.3 83.3-20.2c10.8-8.1 21.1-27.7 22-42.9c0.4-7.6-1.2-13.6-4.3-17.4s-8.3-6.7-18.8-6.6l-0.2-18.7c14.5-0.1 26.2 4.8 33.4 13.3c7.1 8.6 9.3 19.7 8.6 30.5c-1.3 21.6-12.6 44.2-29.4 56.8c-29.9 22.3-69.3 31.6-99.5 23.2c-14-3.9-26.4-12.4-32.8-25.5c-9.5 45.4 4.3 87.7 30.7 116.9c3.5 3.8 7.1 7.4 11 10.8c-2.8-7.9-4-16.1-3.7-24.1c0.5-14.3 6.1-28.3 17.2-38c9.1-7.9 21.8-12.5 36.8-12.5c1 0 2 0 3.1 0.1c2.4 0.1 4.8 0.3 7.2 0.6l-2.4 18.5c-15.6-2-25.7 1.5-32.4 7.4c-6.7 5.9-10.4 14.6-10.8 24.6c-0.7 20 12.1 43.4 39.7 50.2l0 0.2c27.2 5.2 57.5 0.4 88-18.2c0 0 0 0 0.1 0c6.3-4.5 9.8-8.8 11.4-12.6c2-4.4 1.9-8.3 0.5-12.4c-2.8-8.3-12.9-16.8-22.2-19.2c-15-3.8-24.5 1.4-29 7.7c-4.5 6.3-4.7 12.4 2.2 17.8l-11.5 14.8c-14.2-11-15.1-30.5-5.9-43.4c6.9-9.7 19-16.3 33.6-16.8a47 47 0 0 1 1.8 0c4.3 0 8.8 0.6 13.4 1.8c15.5 4 29.8 15.3 35.3 31.2a36.2 36.2 0 0 1 1.9 13.3c16.7-8.5 34.3-16.1 52.3-21.8c30.2-13.8 43.2-37.9 42.7-58.3c-0.5-20.5-13.2-37.7-42.4-40.6l1.8-18.6c36.7 3.6 58.5 29.8 59.2 58.8c0.4 16.8-5.8 34.4-18.2 49.3c16.1-1.8 32-1.5 47.5 1.6c-3.2-6.5-4.7-13.5-4.5-20.4c0.7-22 19.4-42.6 48.9-42.9a66 66 0 0 1 6 0.2l-1.5 18.6c-24.9-2-34.3 11.1-34.7 24.7c-0.4 13.4 8.5 28.4 34.2 30.4c28.3 0.2 48.6-15.1 58.5-37.9c13.3-30.5 7-76.3-34.8-118.2c-0.8-0.8-1.6-1.6-2.4-2.4a40.4 40.4 0 0 1-2.8 10.8c-7.2 17.4-24.2 29.1-41.9 32.4c-24.3 4.5-44.3-5.3-53.5-20.4c-9.2-15.1-6.8-36.4 9.8-47.6l10.5 15.5c-8.9 6-9.3 14.2-4.3 22.3c5 8.1 16.2 15.2 34.2 11.8c11.3-2.1 23.9-11.3 28-21.2c2.1-5 2.5-9.9 0.4-15.5c-1.7-4.6-5.2-9.8-11.7-15.2l-0.2-0.2c-27.3-20.6-56.3-35.4-85.8-45.2c0 0 0 0.1 0.1 0.1c6.7 12.2 7.2 26.1 3.1 38.3c-8.2 24.5-34.1 43.8-66 42.8c-6.9-0.2-13.6 3.1-19.2 9.7c-5.6 6.5-9.7 16.1-10.7 26.3c-1.9 20.4 6.9 42.9 41.3 54L277 258.3c-41.1-13.3-56.8-45.5-54.2-73.5c1.3-14 6.7-27 15.2-36.8s20.5-16.6 34-16.2c24 0.8 42.3-14.1 47.7-30.1c2.7-8 2.3-15.9-1.8-23.4c-4-7.3-11.8-14.4-25.9-19.7a292.6 292.6 0 0 0-50.9-4.3M342.3 306.3c-41.9 3.4-87.4 23.4-125.3 46.6c-56 34.2-114.9 26.7-156.7-4.3c16.4 58.8 74.7 70.8 135.5 55.9c6.1-2.3 12.1-6.5 17.2-12c7.1-7.6 12.2-17.5 13.8-25.6l18.3 3.6c-2.4 12.4-9.1 24.7-18.4 34.7c-8.9 9.6-20.6 17.4-34.1 19.4c-6.8 15.1-12.3 29.7-14.6 39.9c-3.5 16.1 14.2 22.2 22.2 6c19-38.7 45.9-73.2 79.4-103c26.1-17.2 48.4-38.3 62.7-61.2z",
  "brain-tentacle":"M209.5 18.7c-7.4 0-14.8 1.9-19.2 7c-3.1 3.6-4.8 8.5 0 19.2c5.2 8.1 9.3 19.1 12.9 33.1l-17.9 4.7c-6.1-23.7-13.8-33-18.5-35.1c-2.4-1-4.7-1.1-8.3 0c-3.7 1.1-8.4 3.7-13.5 7.5c-7.9 5.8-12.6 13.2-12.4 19.2c3.7 12.4 13.1 18.6 25 24.2l-8 16.8c-4.6-2.1-8.7-4.4-12.4-6.8c-13.3-7.3-23.1-10.4-28-10c-2.6 0.2-4.1 0.8-6 2.8c-2 2-4.4 5.7-6.5 11.6c-3.5 9.9-4 17.7-1.5 21.8c2 3.2 7.2 6.9 20.1 8.2c3.3 0.1 6.7 0.2 10.4 0.4v0.1h1.1l0.2 18.7c-3.8 0-7.3-0.1-10.6-0.4c-11.1-0.1-17.7 0.8-20.2 2.1c-1.6 0.8-2.1 1.3-2.9 3c-0.9 1.8-1.8 5.1-2.4 10c-0.6 4.5-0.2 7.6 0.7 9.8c0.9 2.1 2.1 3.6 5.3 5.3c6.5 3.5 21.7 5.8 47.3 3.7l1.5 18.6c-17.2 1.5-30.7 1.5-41.5-0.5c4.7 15.1 14.5 21.9 25.7 21.9h94c10.6 0 19.8-7.7 23.4-22.1l8.1-32.1l9.9 31.6c4.7 14.8 14.2 22.6 23.5 22.6H383c11.2 0 21.1-6.9 25.7-22c-10.9 2.1-24.6 2.1-42.4 0.6l1.6-18.6c25.6 2.1 40.7-0.2 47.2-3.7c3.2-1.7 4.4-3.2 5.3-5.3c1.4-6.3 2.1-19.3-4.5-22.8c-2.5-1.2-9.1-2.2-20.2-2.1c-3.3 0.3-6.8 0.4-10.6 0.4l0.2-18.7h1v-0.1c3.8-0.2 7.2-0.3 10.4-0.4c12.9-1.3 18.2-5 20.2-8.2c2.5-4.1 2-11.9-1.6-21.8c-2.3-6.2-6-13.8-12.4-14.4c-17.1 2.1-29.1 9.7-40.4 16.8l-8-16.8c4.4-2 7.7-4.2 11.7-6.6c10.2-6.9 13-13 13.3-17.6c0.2-6-4.6-13.4-12.4-19.2c-5.2-3.8-9.8-6.3-13.5-7.5c-3.6-1.1-6-1-8.3 0c-1.7 0.7-3.7 2.3-5.8 5.1c-5.7 9-10.4 21.3-12.7 30l-18.1-4.7c4.1-15.8 8.8-27.6 15-35.9c3.3-8.8 1.7-13.1-1.1-16.4c-9.4-7.7-28.3-9.7-38.7-2c-4.5 3.3-8.1 8.5-10.9 15c-5.5 13-7.1 30.9-7.1 44v0.1l-0.2 30.8v0.1h-18.6v-0.1l-0.2-30.8v-0.1c0-13.1-1.6-31-7.2-44c-2.7-6.5-6.3-11.7-10.8-15c-4.5-2.9-12-4.9-19.4-4.9m47.2 217.9c-7.9 10.7-19.4 17.6-32.8 17.6h-42.8c2 4.3 5.4 8.2 10 11.8c11.8 9 32.1 15 53.6 16.4l-0.6 0.6c-7.9 8.5-33.2 6.5-48 0.9c-35-12.8-67.9-21.9-101.3-11.1c-43.8 17.3-74.9 66.9-65.5 113.1c10.4 51.3 66.8 124.2 121.1 99.8c61.3-27.6 11.4-114.5-25.3-132.1c8.5 23.2 39.8 79.9 11.4 91.9c-34.2 14.4-81.6-43.6-69.5-86.9c20.7-57.4 66.1-49.5 99.4-37.5c60.3 21.7 31.2 169.9 95.2 167.1c38.9-1.7 85.4-60.7 48.7-106.3c3.9 28.6-20.4 75.5-42.9 63.4c-33.8-18.1 12.2-84.5 43.7-106.6c24.4-17.1 70.6-28.1 89.5-3.7c29.8 38.6-53.2 74.2-27.7 118.3c22.5 39 75.7 47.4 117.6-10.8c-29.1 17.4-68.6 25.8-79.6 1.6c-14.1-31.1 62.7-35.3 69.1-76c5.8-36.7-18.3-73.9-49.6-93.9c-39.9-25.6-109.3 30.9-160.3 7.7c19.7-2.1 37.9-8.1 48.6-16.7c4.2-3.4 7.3-7 9.3-11h-39.2c-12.9 0-24.2-7-32.1-17.6",
  "brainstorm":"M209.5 21.1c-0.6 0-1.1 0-1.7 0.1h-0.5c-10.4 0-19.2 3.4-23.1 7.9c-3.6 4.3-5.5 10.1-0.1 22.2c5.7 8.8 10.4 20.8 14.3 36.4l-18.1 4.7c-6.8-26.3-15.2-36.8-20.9-39.3c-2.9-1.3-5.7-1.4-9.8-0.1s-9.4 4.2-15.2 8.4c-8.8 6.5-14.3 14.9-14 22c0.2 5.5 3.6 12.6 15.2 20.3c1.1 0.6 2.2 1.2 3.3 1.8l-0.1 0.2a110 110 0 0 0 9.6 5.1l-8 16.9c-5.1-2.4-9.6-4.9-13.7-7.6c-14.7-8-25.5-11.6-31.3-11.1c-3.1 0.3-4.9 1.1-7.2 3.4c-2.3 2.3-4.9 6.5-7.3 13.1c-3.9 11-4.6 20-1.6 24.9c2.4 3.9 8.5 8.1 22.8 9.5c3.6 0.1 7.4 0.2 11.6 0.4v0.1c0.4 0 0.8 0 1.2 0l0.2 18.7c-4.3 0-8.3-0.1-12.1-0.4c-12-0.1-19.2 0.9-22.2 2.4c-1.9 0.9-2.6 1.7-3.6 3.8s-2 5.8-2.7 11.2c-0.6 5-0.2 8.7 0.8 11.3c1.1 2.5 2.6 4.4 6.3 6.4c7.4 4 24.3 6.5 52.6 4.1l1.6 18.6c-21.6 1.8-37.8 1.5-50.3-1.6c-0.9 3.7-0.7 6.7 0 9.1q0.2 0.6 0.4 1.2c0 0 0 0.1 0 0.1a28.1 28.1 0 0 0 6.9 8.4c0 0 0 0 0.1 0c7 5.2 18.6 8.2 25.5 8.2h103.8c12.1 0 22.6-8.9 26.7-25.1l8.1-32.1l9.9 31.6c5.2 16.6 16.1 25.6 26.8 25.6h103.8c6.3 0 18.4-3.9 25.6-10.2a30 30 0 0 0 2.5-2.4c0.1-0.2 0.3-0.3 0.4-0.5c0 0 0 0 0.1-0.1c1.5-1.9 2.7-4 3.8-6.2c0.1-0.3 0.3-0.7 0.4-1c0.6-2.1 0.8-4.3 0.4-6.9c-12.6 3.4-29.2 3.7-51.4 1.8l1.6-18.6c28.2 2.4 45.1-0.1 52.5-4.1c3.7-2 5.2-3.9 6.3-6.4c1.1-2.5 1.5-6.2 0.9-11.3c-0.7-5.4-1.7-9.1-2.7-11.2c-1-2.1-1.7-2.8-3.6-3.8c-3-1.5-10.3-2.5-22.2-2.4c-3.8 0.3-7.8 0.4-12.1 0.4l0.2-18.7c0.4 0 0.8 0 1.2 0v-0.1c4.2-0.2 8-0.3 11.6-0.4c14.4-1.4 20.5-5.6 22.8-9.5c3-4.9 2.3-13.9-1.6-24.9c-2.4-6.6-5-10.8-7.3-13.1c-2.3-2.3-4.2-3.1-7.2-3.4c-5.8-0.5-16.6 3-31.3 11.1c-4.1 2.7-8.6 5.2-13.7 7.6l-8-16.9a109 109 0 0 0 9.6-5.1l-0.1-0.2c1.2-0.7 2.3-1.3 3.5-1.9c11.5-7.7 14.8-14.8 15.1-20.2c0.3-7.1-5.2-15.5-14-22c-5.7-4.2-11-7.1-15.2-8.4s-7-1.2-9.8 0.1c-2 0.9-4.3 2.7-6.8 5.9a68 68 0 0 1-1.5 3.2l-0.6-0.3c-4 6.2-8.3 15.9-12.1 30.6l-18.1-4.7c4.5-17.3 9.7-30.3 16.4-39.3c3.8-10.1 2.1-15.3-1.2-19.2c-3.9-4.5-12.7-7.9-23.1-7.9h-0.5c-9.2-0.5-15.3 1.7-20.4 5.6c-5.1 3.8-9.2 9.6-12.3 16.9c-6.2 14.6-7.9 34.4-7.9 48.9v0.1l-0.2 34v0.1h-18.7v-0.1l-0.2-34v-0.1c0-14.5-1.7-34.4-7.9-48.9c-3.1-7.3-7.2-13.1-12.3-16.9c-4.8-3.6-10.5-5.8-18.7-5.6zm48.8 239.5c-8.5 12.2-21.3 20.2-36.1 20.2H181.5l98.1 80.6l-82.2 1.3l217.4 133.4L342.3 387.8l55.1 4.8l-76-111.8h-27.7c-14.4 0-26.8-8-35.4-20.2z",
  "broadsword":"m491.8 22.5l-83.4 14.9L196.6 249.2c3.3 4.8 5.4 10.7 5.4 16.9c0 5.9-1.7 11.3-4.6 16a53 53 0 0 0-16-2.5c-15.7 0-29.9 6.9-39.7 17.8l-9.1-9.1l17.2-17.2a546 546 0 0 1-13.2-17.6l-19.4 19.4l-13.2-13.2l21.8-21.8a548 548 0 0 1-12.8-20.1L72.1 258.7l58.3 58.3a53 53 0 0 0-2.5 16.1a52.9 52.9 0 0 0 4.6 21.6l-72.1 72.1l-14.6-14.6L21 437l14.6 14.6l-8.6 8.6l27.2 27.2l8.6-8.6l14.6 14.6l24.8-24.8l-14.6-14.6l72.2-72.2a52.9 52.9 0 0 0 21.5 4.6a53 53 0 0 0 16.1-2.5l58.4 58.4L296.5 401.5a549 549 0 0 1-20.1-12.8l-21.8 21.8L241.4 397.3l19.4-19.4a550 550 0 0 1-17.6-13.2l-17.2 17.2l-9.2-9.2c10.9-9.8 17.8-24 17.8-39.7c0-5.3-0.8-10.5-2.3-15.4c4.7-3 10.3-4.8 16.3-4.8c6.2 0 11.8 1.8 16.5 5L477 106zm-66.2 53l13.2 13.2l-191.7 191.7l-13.2-13.2zM181.3 298.4c19.3 0 34.7 15.4 34.7 34.7c0 19.3-15.4 34.7-34.7 34.7s-34.7-15.4-34.7-34.7s15.4-34.7 34.7-34.7",
  "broken-skull":"m206.9 27l-3 2.1c-14.3 9.9-22.8 28-25.3 52.4c-19.3 11.4-38 13.8-50.8 10.9c-4.1 5-6.6 10.7-8.9 16.9c20.5 6.7 47.5 2.7 73.7-14.3l3.9-2.5l0.3-4.7c1.4-21.1 7.6-34.3 15.2-41.2l22.3 3.1c-1.7 18.2-1.4 38.2 7.5 60.4l2.7 6.6l7-0.8c23.8-2.6 31.7-3.7 54.8 0.4l7.5 1.3l2.8-7.1c3.9-10.1 7.8-18.6 12.4-26c6.9 6.7 15.8 12.1 25.3 16.1c11.8 5 24.8 8.1 36.6 5.1c-3.2-5.9-7-12.4-11-18c-5.3-0.2-11.9-1.6-18.4-4.3c-11.3-4.7-21.6-13.2-24.7-18.8L330.5 53l-8.8 9.9c-8.8 9.9-14.5 21.4-19.7 33.9c-16.9-2.4-28.7-2-45.2-0.3c-6.2-19.2-5.4-36.1-3.2-53.8l1.1-9.1l-9.1-1.3l-35.2-4.8l-3.6-0.5zm171.1 6.8L367.7 49.8c18 12.9 30 27.3 40.4 47.8l3.3 6.5l-4.3 5.9c-6.3 8.7-11.4 19.7-15.9 32.4c4.1 11.2 6.3 24.7 6.3 36l0 14.2l-14-2.3L354 185.5l-26.6 29.2l-12 13.1l-7.8-15.9l-16.6-34c-10.4 12.9-19.3 23.2-30.6 30.9c-15.3 10.5-34.3 14.4-61 12.6l-8.1-0.6l-2.5-7.8L177.8 179l-40.6 7.8l-11.9 2.3l-2.2-12s-2.3-12.1-6.3-25.5c-2-6.7-4.5-13.7-7.2-19.2s-5.8-9.4-6.8-10l-6.5-4.7l1.9-7.8c4.6-19.2 17.2-36 37.2-50.4l-10.7-19.8C56.1 95.6 25.5 197.8 24.1 296.3c43.8 23 73.8 47.8 92.3 74.8c17.7 25.9 24.5 53.7 23.4 81.6c11.5 6.3 23 11.9 35.7 15.3c21.8 5.8 45.4 8.7 69.8 8.7c24.4 0 49.4-2.8 72.4-8.7c18.3-4.7 35.1-11.8 50.7-20.5c1.9-55.3 35.3-110.1 118.8-151.5c-1.6-97.4-34-206.6-109.1-262.2zM202.4 250.1c6 3.2 11.2 7.9 14.6 13.8c12.2 21.2-1 51.6-29.2 67.9c-28.3 16.3-61.3 12.1-73.5-9c-7-12.1-5.5-27 2.2-40.8c12.8-0.2 28-2.8 44.2-9c15.5-5.9 30.1-14.1 41.7-22.8zm106.2 0c11.6 8.7 26.2 16.9 41.7 22.8c16.3 6.2 31.4 8.8 44.2 9c7.6 13.8 9.1 28.7 2.2 40.8c-12.2 21.2-45.2 25.3-73.5 9c-28.3-16.3-41.4-46.7-29.2-67.9c3.4-5.9 8.6-10.6 14.6-13.8zm-53.1 75.6c18.5 36.1 33.2 72.2 40.5 108.4c-27-8.2-54-9.3-81.1 0c9.9-36.1 21.7-72.2 40.5-108.4",
  "bubbling-flask":"M186.2 21.2c1.3 7.7 2.8 14.9 4.4 21.6h-25l10.5 14.8s13.7 19.3 21.8 43.8c4 12.2 6.6 25.6 5.6 38c-1 12.4-5.1 23.7-15.1 33.7c-20.3 20.3-47.9 40.2-71 64.4c-23.1 24.2-41.8 53.5-41.8 91.7c0 2 0 39.5 0 76.8c0 18.7 0 37.3-0.1 51.6c0 7.1 0 13.2 0 17.5c0 4.4-0.1 7.6-0.1 7.3l-0.3 9.6l9.6 0.1l312.5 2.3l9.8 0.1l-0.3-9.8c0 0.2 0-3.1-0.1-7.6s0-10.6-0.1-17.8c0-14.4-0.1-33.3-0.1-52.2c-0.1-37.7-0.1-75.5-0.1-77.9c0-39-19.5-68.7-43.5-93c-24-24.3-52.7-44.1-73.8-64.4c-10-9.6-13.8-20.5-14.4-32.6s2.5-25.3 7.2-37.5c9-23.5 23-42 24-43.3l15.5-15.6h-32.5c1.6-6.7 3.1-13.9 4.4-21.6zM217 99.8c14.5 15.5 31.1 15.6 45.7 0.1c-4.3 12.5-7.3 26.3-6.6 40.3c0.8 15.8 6.6 32.1 20.1 45.1v0c22.7 21.9 51.2 41.5 73.5 64.1c22.3 22.6 38.1 47.1 38.1 79.9c0 2.5 0 40.2 0.1 78c0 18.9 0.1 37.7 0.1 52.2c0 6.6 0 11.9 0.1 16.3l-293.7-2.2c0-4.2 0-9.4 0-15.8c0-14.3 0-32.9 0.1-51.6c0-37.4 0-74.7 0-76.8c0-32.1 15.2-56.3 36.7-78.8c21.4-22.4 48.8-42.2 70.7-64.1c13.2-13.3 19.3-29.5 20.5-45.4c1.1-14.3-1.3-28.4-5.2-41.2zm34.5 98.8c-17.3 0-31.5 14.2-31.5 31.5c0 17.3 14.2 31.5 31.5 31.5S283 247.4 283 230.1s-14.2-31.5-31.5-31.5zm0 18.7c7.2 0 12.8 5.6 12.8 12.8s-5.6 12.8-12.8 12.8c-7.2 0-12.8-5.6-12.8-12.8c0-7.2 5.6-12.8 12.8-12.8zM131.5 277.6c-10.6 14.9-18.1 31.6-18.1 52c0 5.3-0.1 119.6-0.3 124.7l256.1 3.8c-0.3-6.4-0.5-121.9-0.5-128.5c0-20.4-7.5-37.1-18.1-52h-37a37.8 37.8 0 0 1 5 18.8c0 21-17.2 38.2-38.2 38.2c-21 0-38.2-17.2-38.2-38.2a37.8 37.8 0 0 1 5-18.8H131.5zm144 0c-8.5 2.1-14.6 9.6-14.6 18.8c0 10.9 8.6 19.5 19.5 19.5c10.9 0 19.5-8.6 19.5-19.5c0-9.2-6.2-16.7-14.7-18.8zM211.3 319.5c18.9 0 34.4 15.5 34.4 34.4c0 18.9-15.5 34.5-34.4 34.5s-34.5-15.6-34.5-34.5c0-18.9 15.6-34.4 34.5-34.4zm0 18.7c-8.8 0-15.8 6.9-15.8 15.8s7 15.8 15.8 15.8s15.8-7 15.8-15.8s-6.9-15.8-15.8-15.8m93 10.1c25.5 0 46.4 20.9 46.4 46.4c0 25.5-20.9 46.4-46.4 46.4c-25.5 0-46.4-20.9-46.4-46.4s20.9-46.4 46.4-46.4zM304.3 367c-15.4 0-27.8 12.3-27.8 27.8s12.3 27.8 27.8 27.8s27.8-12.3 27.8-27.8c0-15.4-12.3-27.8-27.8-27.8",
  "bullseye":"M311.1 257.9a15.1 15.1 0 0 1-12.8 17l-147.2 20.6l-21.3 32.5l-82.6 11.6l21.3-32.6l-24.5 3.4c-0.3 0-0.6 0.1-0.8 0.2a15 15 0 0 1-2.1 0.1a15.1 15.1 0 0 1-2.1-30c0.3 0 0.6 0 0.9-0.1l24.5-3.4l-29.4-25.5l82.6-11.5l29.4 25.5l147.3-20.6a15 15 0 0 1 2.1-0.1a15.1 15.1 0 0 1 15 12.9zm-36.7-38.5a32.4 32.4 0 0 1 10.8-10.3a23.4 23.4 0 0 1 13.4-3a27.9 27.9 0 0 1 13.5 5a44.6 44.6 0 0 1 11.9 12.6a66.3 66.3 0 0 1 8.4 19.1a77.5 77.5 0 0 1 2.6 22a67.9 67.9 0 0 1-3.5 20a46.1 46.1 0 0 1-8.5 15.4a28.2 28.2 0 0 1-12.4 8.6a23.4 23.4 0 0 1-13.8 0.3a32 32 0 0 1-12.5-7.1a45.5 45.5 0 0 1-5.7-6.2l-32.3 4.5a131 131 0 0 0 7.1 16a104.6 104.6 0 0 0 18.7 25.5a69 69 0 0 0 23.9 15.8a48.4 48.4 0 0 0 27.6 2.2a53.4 53.4 0 0 0 26.3-14.9c7.9-7.9 14.4-18.3 19.1-30.5a132 132 0 0 0 8.3-42a153.3 153.3 0 0 0-5.5-46.9a128.8 128.8 0 0 0-18.5-39.9c-7.6-10.7-16.4-18.9-25.8-24.4a53 53 0 0 0-28-7.6a48.6 48.6 0 0 0-26.3 8.7a69.9 69.9 0 0 0-20.2 21.9a107.5 107.5 0 0 0-12 29.5A137 137 0 0 0 237.7 235l31.2-4.4a49.2 49.2 0 0 1 5.6-11.2m198.3-35c-10.9-35.3-27.3-64.8-46.8-87.4c-18.6-21.5-39.5-36.3-61.1-44.2c-20.2-7.4-40.6-8.7-60-4.2c-18.1 4.2-35.2 13.5-50.6 27.6c-14.4 13.2-26.1 29.6-35.2 47.8a233.2 233.2 0 0 0-19.3 56.6a286 286 0 0 0-5.9 60.7l22.6-3.2a209 209 0 0 1 5-40.3a166.3 166.3 0 0 1 16-42.9c7.4-13.4 16.7-25.1 28-34.1c11.9-9.4 24.9-15 38.3-16.6c14.2-1.8 28.8 0.7 42.9 7.5c14.9 7.1 29.1 18.8 41.5 34.8c12.9 16.6 23.5 37.5 30.7 61.9a225.5 225.5 0 0 1 8.7 74.7c-1.3 24.1-6.4 46.4-14.7 65.7c-8 18.6-18.9 33.9-31.8 44.9c-12.3 10.5-26.3 16.9-41.5 18.7a76.2 76.2 0 0 1-41.2-7.1c-12.3-5.7-23.8-14.5-34-25.5a162.2 162.2 0 0 1-25.7-37.6a204.6 204.6 0 0 1-14.5-38.6l-22.5 3.1a281 281 0 0 0 20 57.8a228.2 228.2 0 0 0 32.2 50.1c13 15.2 27.8 27.8 43.9 36.8c17.2 9.6 36 15.1 55.7 14.9c21.3-0.2 41.4-7 59.5-19.8c19.4-13.7 36-33.9 48.6-59.4c13.2-26.8 21.7-58.8 24-93.6a300.7 300.7 0 0 0-12.9-108.8z",
  "burning-skull":"m268.7 389.3l3.7 28.7h-30.9l3.7-28.7a11.7 11.7 0 1 1 23.4 0m33.8-71.8a29.5 29.5 0 1 0 29.5 29.5a29.5 29.5 0 0 0-29.5-29.5zm-94.4 0a29.5 29.5 0 1 0 29.5 29.5a29.5 29.5 0 0 0-29.5-29.5zm245.7-62c0 98.2-48.2 182.7-117.4 220.2c-46 28.3-112.8 28.3-156.2 2.5c-71.7-36.2-122.2-122.3-122.2-222.7c0-78.2 30.5-147.6 77.9-191.7c0 0-42.1 82.9 9.1 135c-11.7-173.8 169.3-63 118-184c151.8 83.3 9.1 105 84.1 148.2c0 0 66.2 47 36.4-91.7c43 44 70.2 110.3 70.2 184.2zm-68.5 29.9c-2.5-65.5-54.9-119.6-120.3-124.1c-3.1-0.2-6.2-0.3-9.2-0.3a129.4 129.4 0 0 0-129.4 129.3a132.2 132.2 0 0 0 24.5 76v25a35 35 0 0 0 34.7 34.7h6.3v16.6a34.7 34.7 0 0 0 34.7 34.4h61.8a34.5 34.5 0 0 0 34.5-34.4v-16.6h5.4a34.9 34.9 0 0 0 34.6-34.8v-28a129.3 129.3 0 0 0 22.3-77.9z",
  "calendar":"M119 31v66h18V31zm256 0v66h18V31zM73 89v30h366V89h-28v26h-54V89H155v26h-54V89zm0 48v302h366V137zm110 14h18v32h46v-32h18v32h46v-32h18v32h46v-32h18v32h32v18h-32v46h32v18h-32v46h32v18h-32v46h32v18H265v32h-18v-32h-46v32h-18v-32h-46v32h-18v-32H87v-18h32v-46H87v-18h32v-46H87v-18h32v-46H87v-18h96zm-46 50v46h46v-46zm64 0v46h46v-46zm64 0v46h46v-46zm64 0v46h46v-46zm-192 64v46h46v-46zm64 0v46h46v-46zm64 0v13.3A25.4 25.4 0 0 1 278.3 265zm32.7 0A25.4 25.4 0 0 1 311 278.3V265zm31.3 0v46h46v-46zm-41 16c-4 0-7 3-7 7s3 7 7 7s7-3 7-7s-3-7-7-7m-23 16.7V311h13.3A25.4 25.4 0 0 1 265 297.7m46 0A25.4 25.4 0 0 1 297.7 311H311zM137 329v46h46v-46zm64 0v46h46v-46zm64 0v46h46v-46zm64 0v46h46v-46z",
  "castle":"M254.2 15.3c-132.5 0-240.2 107.6-240.2 240.2c0 132.5 107.7 240.2 240.2 240.2S494.4 388 494.4 255.5S386.8 15.3 254.2 15.3m0 18.7c122.4 0 221.5 99 221.5 221.5c0 65.7-28.5 124.6-73.8 165.1V238.8l14-22.8h-7.6L364 101.5l-43.8 114.5h-8.2l14.6 22.8v33.9h-36.8v-88.2l14.6-22.8h-7.6l-44.4-114.5l-44.4 114.5h-7.6l14 22.8v123.2h-37.4v-18.1l14.6-22.8h-8.2l-43.8-114.5L95.3 266.8H87.8l14 22.8V416.2C59.2 375.9 32.8 318.8 32.8 255.5c0-122.4 99.1-221.5 221.5-221.5zm1.1 160.5h18.7v36.3h-18.7v-36.3zm110.2 88h18.7v36.3H365.5V282.5zm-246.7 22h18.7v36.3h-18.7v-36.3zm50.9 29.4h18.7v36.3H169.7V334zm170.8 30.5h18.7v36.3h-18.7z",
  "check-mark":"M17.5 250.9C88.8 328.1 158 397.6 224.5 485.5c72.3-143.8 146.3-288.1 268.4-444.4L460 26.1C356.9 135.4 276.8 238.9 207.2 361.9c-48.4-43.6-126.6-105.3-174.4-137z",
  "checked-shield":"M48.9 19.7v10.8c0 103.2 10.5 206.1 41.3 289.5c30.8 83.5 82.8 148.1 164.5 170.6l2.2 0.6l2.2-0.5c89.7-19.1 142.3-84 171.2-168.3S465.8 133.7 465.8 30.4v-10.8l-10.7 1.5C323.3 40 191.5 40 59.6 21.2l-10.7-1.5zM67.8 41c63.2 8.5 126.5 12.8 189.8 12.8v184.5h174.8c-4.9 27.6-11.3 53.7-19.6 77.9c-27.3 79.9-73.8 137.3-155.2 155.6c0 0 0 0 0 0v-233.5H86.5c-12.9-61-18.3-128.8-18.8-197.3z",
  "checklist":"m122.3 84.6l-2.9 8.5l-11.4 34.2l-5.7-5.7L96 115.3L83.3 128l6.4 6.4l26.3 26.3l20.6-61.8l2.8-8.5l-17.1-5.7zM151 119v18h242v-18zm0 64v18h242v-18zm0 64v18h242v-18zm-28.7 29.6l-2.9 8.5l-11.4 34.2l-5.7-5.7L96 307.3L83.3 320l6.4 6.4l26.3 26.3l20.6-61.8l2.8-8.5l-17.1-5.7zM151 311v18h242v-18zm0 64v18h242v-18z",
  "claw-hammer":"M216 27.8c-2.2 0-4.3 0.2-6.4 0.4l-0.5 0.1c-2.8 0.3-5.8 1-9.1 1.8c-4.4 1.1-8.1 2.6-11.1 4.4l77.8 59.3l7.4 5.7l-5.6 7.4l-13.7 18.2l67.6 51.6l14.2-18.8l9.5-12.5l6.5 14.3l19.7 43.5l60.6-80.1l-47.2-7.1l-15.5-2.3l9.5-12.6l14.3-18.8l-67.6-51.6L310.8 50.8l-5 6.7l-7.2-4.2c-28.6-16.9-58-25.2-80.3-25.4a77 77 0 0 0-2.2 0zM453 127.1l-71.5 94.4l34.6 26.2c44.2-20.2 64-52.6 71.3-94.6zm-193.7 25c-27.2 33.1-55.3 64.7-82.8 96.2l47.4 39.9c23.1-35.3 46.3-71.6 71.9-108.2l-36.5-27.9zM164.2 262.5c-11.4 13.1-22.6 26.3-33.5 39.5l48.4 52.7c11.7-16.6 23.1-33.5 34.4-50.7zm-45.4 54.1a1112 1112 0 0 0-23.1 29.7l33.5 73.8c13.6-16.2 26.4-32.9 38.8-49.9zm-35.8 47c-12.1 17-23.6 34.3-34.1 52.3L98.5 454.5a688 688 0 0 0 17.2-18.7zm-43.4 68.7a546 546 0 0 0-14.8 29l37.4 28.3a611 611 0 0 0 23.1-21.7z",
  "coins":"M136 25c-16.5 0-31.3 3.4-41.3 8.4c-9.9 5-13.7 10.6-13.7 14.6c0 3.9 3.8 9.6 13.7 14.5c10 5 24.8 8.5 41.3 8.5s31.3-3.5 41.2-8.5c10-4.9 13.8-10.6 13.8-14.5c0-4-3.8-9.6-13.8-14.6c-9.9-5-24.7-8.4-41.2-8.4m160 32c-16.5 0-31.3 3.4-41.2 8.4c-10 5-13.8 10.6-13.8 14.6c0 3.9 3.8 9.6 13.8 14.5c9.9 5 24.7 8.5 41.2 8.5c4.6 0 9-0.3 13.2-0.8c4.3-5.5 10.4-10.4 17.5-13.6c8.2-3.7 17.7-6.7 24.3-8.6c0-4-3.8-9.6-13.8-14.6c-9.9-5-24.7-8.4-41.2-8.4M81 75.4c-0.4 14.7 15.5 20.6 25.5 23.6c17.9 5.2 41.1 5.2 59 0c12.8-3.7 25.4-10.7 25.5-23.6c-16.1 10.6-39.6 13.5-55 13.6c-19.5-1.6-40-3.6-55-13.6M376 96.3c-16.5 0-31.3 3.4-41.2 8.5c-10 4.9-13.8 10.6-13.8 14.5c0 4 3.8 9.6 13.8 14.6c9.9 5 24.7 8.4 41.2 8.4s31.3-3.4 41.2-8.4c10-5 13.8-10.6 13.8-14.6c0-3.9-3.8-9.6-13.8-14.5c-9.9-5.1-24.7-8.5-41.2-8.5M241 107.4v2.4c2.9 1 5.7 2.2 8.3 3.5c9 4.5 16.8 10.8 20.8 18.7c10.2 2.5 21.7 3.4 32.9 2.7v-13.9c-2.3 0.1-4.6 0.2-7 0.2c-18.9 0-36.1-3.7-49.3-10.3q-3-1.5-5.7-3.3m-160 0.1c-0.3 14.6 15.5 20.6 25.5 23.6c6.8 1.9 14.4 3.2 22.2 3.6c2-5.2 5.6-9.8 10.2-13.7c-12.8 0.3-25.7-1.3-37.4-4.6c-7.8-2.3-14.7-5.2-20.5-8.9M200 121c-16.5 0-31.3 3.5-41.2 8.4c-10 5-13.8 10.6-13.8 14.6s3.8 9.6 13.8 14.6c9.9 5 24.7 8.4 41.2 8.4s31.3-3.4 41.2-8.4c10-5 13.8-10.6 13.8-14.6s-3.8-9.6-13.8-14.6c-9.9-4.9-24.7-8.4-41.2-8.4M81 139.5c-0.3 14.6 15.5 20.6 25.5 23.6c6.3 1.8 13.3 3 20.5 3.5v-13.8c-8.8-0.6-17.4-2.1-25.5-4.4c-7.8-2.3-14.7-5.2-20.5-8.9M321 146.8c-0.2 14.7 15.4 20.6 25.5 23.6c17.9 5.2 41.1 5.2 59 0c12.7-3.7 25.4-10.7 25.5-23.6c-1.8 1.1-3.7 2.2-5.7 3.2c-13.2 6.6-30.4 10.3-49.3 10.3s-36.1-3.7-49.3-10.3c-2-1-3.9-2.1-5.7-3.2m-48 4.2v13.7c9.4 1.9 19.9 2.6 30 2v-13.8c-10.1 0.5-20.3-0.1-30-1.9m-128 20.4c-0.5 6 2.2 10.9 5.5 13.8c4.2 3.6 11 7.3 20 9.9c17.9 5.1 41.1 5.1 59 0c9-2.6 15.8-6.3 20-9.9c4.9-4.1 5.5-8.1 5.5-13.8q-2.7 1.8-5.7 3.3c-13.2 6.6-30.4 10.3-49.3 10.3s-36.1-3.7-49.3-10.3q-3-1.5-5.7-3.3m-64 0.1c-0.3 14.6 15.5 20.6 25.5 23.6c6.3 1.8 13.3 3 20.5 3.5v-13.8c-8.8-0.6-17.4-2.1-25.5-4.4c-7.8-2.3-14.7-5.2-20.5-8.9M321 178.8c-0.2 14.7 15.4 20.6 25.5 23.6c17.9 5.2 41.1 5.2 59 0c12.7-3.7 25.4-10.7 25.5-23.6c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.3-47.3 6.3-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m-48 4.2v13.7c9.4 1.9 19.9 2.6 30 2v-13.8c-10.1 0.5-20.3-0.1-30-1.9M81 203.5c-0.3 14.6 15.5 20.6 25.5 23.6c6.3 1.8 13.3 3 20.5 3.5v-13.8c-8.8-0.6-17.4-2.1-25.5-4.4c-7.8-2.3-14.7-5.2-20.5-8.9m64 0c-0.5 6 2.2 10.8 5.5 13.7c4.2 3.6 11 7.3 20 9.9c17.9 5.1 41.1 5.1 59 0c9-2.6 15.8-6.3 20-9.9c4.9-4.1 5.5-8 5.5-13.7c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.2-47.3 6.2-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m176 7.3c-0.2 14.7 15.4 20.6 25.5 23.6c17.9 5.2 41.1 5.2 59 0c12.7-3.7 25.4-10.7 25.5-23.6c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.3-47.3 6.3-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m-48 4.2v13.7c9.4 1.9 19.9 2.6 30 2v-13.8c-10.1 0.5-20.3-0.1-30-1.9m-128 20.5v2.3c2.9 1 5.7 2.2 8.3 3.5c9 4.5 16.8 10.8 20.8 18.7c17.3 4.2 38.7 3.9 55.4-0.9c9-2.6 15.8-6.3 20-9.9c4.9-4.1 5.5-8 5.5-13.7c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.2-47.3 6.2-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m176 7.3c-0.2 14.7 15.4 20.6 25.5 23.6c17.9 5.2 41.1 5.2 59 0c12.7-3.7 25.4-10.7 25.5-23.6c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.3-47.3 6.3-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m-48 4.2v13.7c9.4 1.9 19.9 2.6 30 2v-13.8c-10.1 0.5-20.3-0.1-30-1.9m-169 2c-16.5 0-31.3 3.5-41.3 8.4c-9.9 5-13.7 10.6-13.7 14.6s3.8 9.6 13.7 14.6c10 5 24.8 8.4 41.3 8.4c16.5 0 31.3-3.4 41.2-8.4c10-5 13.8-10.6 13.8-14.6s-3.8-9.6-13.8-14.6c-9.9-4.9-24.7-8.4-41.2-8.4m151 18.5c-5.8 3.7-12.7 6.6-20.5 8.9c-18 5.1-38.6 6-57.5 2.6v13.7c16.8 3.5 36.7 2.9 52.5-1.6c12.6-3.7 25.4-10.8 25.5-23.6m66 7.3c-0.3 14.2 14.7 20.3 24.6 23.3c5.6-4.5 10.7-7.9 16.7-10.4c-7.2-0.8-14.2-2.1-20.8-4c-7.8-2.3-14.7-5.2-20.5-8.9m110 0c-2.8 1.8-5.9 3.4-9.3 4.9c3.1 0.3 6.2 0.7 9.1 1.2c0.4-2 0.2-4 0.2-6.1M273 279v13.6c10.9 2.1 20 2.6 30 2.2v-13.9c-10.1 0.5-20.3-0.1-30-1.9m135 18c-16.5 0-31.3 3.5-41.2 8.4c-10 5-13.8 10.6-13.8 14.6s3.8 9.6 13.8 14.6c9.9 5 24.7 8.4 41.2 8.4s31.3-3.4 41.2-8.4c10-5 13.8-10.6 13.8-14.6s-3.8-9.6-13.8-14.6c-9.9-4.9-24.7-8.4-41.2-8.4m-359 2.4c-0.3 14.8 15.3 20.7 25.5 23.7c17.9 5.1 41.1 5.1 59 0c12.7-3.7 25.4-10.8 25.5-23.7q-2.7 1.8-5.7 3.3c-13.2 6.6-30.4 10.3-49.3 10.3c-19.6-1.6-39.9-3.6-55-13.6m206 0.1c-5.8 3.7-12.7 6.6-20.5 8.9c-18 5.1-38.6 6-57.5 2.6v13.7c16.8 3.5 36.7 2.9 52.5-1.6c12.6-3.7 25.4-10.8 25.5-23.6m66 7.3c-0.4 10.3 8 16.1 13.8 19.1c0 0 0.1 0.1 0.2 0.1v-12.4c-5.2-1.9-9.9-4.2-14-6.8M49 331.5c-0.3 14.6 15.5 20.6 25.5 23.6c17.9 5.1 41.1 5.1 59 0c12.6-3.7 25.4-10.8 25.5-23.6c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.2-47.3 6.2-69 0c-7.8-2.3-14.7-5.2-20.5-8.9M177 343v13.6c4.9 1.1 10.2 1.8 15.7 2.2c2-5.3 5.6-9.9 10.2-13.8c-8.7 0.2-17.5-0.5-25.9-2m87 2c-16.5 0-31.3 3.5-41.2 8.4c-10 5-13.8 10.6-13.8 14.6s3.8 9.6 13.8 14.6c9.9 5 24.7 8.4 41.2 8.4s31.3-3.4 41.2-8.4c10-5 13.8-10.6 13.8-14.6s-3.8-9.6-13.8-14.6c-9.9-4.9-24.7-8.4-41.2-8.4m89 2.4c-0.1 14.8 15.2 20.7 25.5 23.7c17.9 5.1 41.1 5.1 59 0c12.7-3.7 25.4-10.8 25.5-23.7c-15.8 9.6-39.7 13.5-55 13.6c-19.6-1.6-39.9-3.6-55-13.6M49 363.5c-0.3 14.6 15.5 20.6 25.5 23.6c17.9 5.1 41.1 5.1 59 0c12.6-3.7 25.4-10.8 25.5-23.6c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.2-47.3 6.2-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m304 16c-0.2 14.7 15.4 20.6 25.5 23.6c17.9 5.1 41.1 5.1 59 0c12.6-3.7 25.4-10.8 25.5-23.6c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.2-47.3 6.2-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m-144 15.9c-0.5 6 2.2 10.9 5.5 13.8c4.2 3.6 11 7.3 20 9.9c17.9 5.1 41.1 5.1 59 0c9-2.6 15.8-6.3 20-9.9s5.5-6.7 5.5-9.2v-4.6q-2.7 1.8-5.7 3.3c-13.2 6.6-30.4 10.3-49.3 10.3s-36.1-3.7-49.3-10.3q-3-1.5-5.7-3.3m-160 0.1c-0.3 14.6 15.5 20.6 25.5 23.6c17.9 5.1 41.1 5.1 59 0c12.6-3.7 25.4-10.8 25.5-23.6c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.2-47.3 6.2-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m304 16c-0.2 14.7 15.4 20.6 25.5 23.6c17.9 5.1 41.1 5.1 59 0c12.6-3.7 25.4-10.8 25.5-23.6c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.2-47.3 6.2-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m-304 16c-0.3 14.6 15.5 20.6 25.5 23.6c17.9 5.1 41.1 5.1 59 0c12.6-3.7 25.4-10.8 25.5-23.6c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.2-47.3 6.2-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m160 0c-0.4 10.3 8 16.1 13.8 19.1c9.9 5 24.7 8.4 41.2 8.4s31.3-3.4 41.2-8.4c9.9-6.2 13.8-8.6 13.8-19.1c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.2-47.3 6.2-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m144 16c-0.4 10.3 8 16.1 13.8 19.1c9.9 5 24.7 8.4 41.2 8.4s31.3-3.4 41.2-8.4c9.9-6.2 13.8-8.6 13.8-19.1c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.2-47.3 6.2-69 0c-7.8-2.3-14.7-5.2-20.5-8.9m-304 16c-0.4 10.2 7.9 16.1 13.7 19.1c10 5 24.8 8.4 41.3 8.4c16.5 0 31.3-3.4 41.2-8.4c9.9-6.2 13.8-8.6 13.8-19.1c-5.8 3.7-12.7 6.6-20.5 8.9c-21.7 6.2-47.3 6.2-69 0c-7.8-2.3-14.7-5.2-20.5-8.9",
  "coins-pile":"M431.1 23.5c-9.5 17.3-25.4 23.3-49.6 14.2c17.9 10.2 28.5 25 24.6 48.6c12.4-21.3 29.2-24.5 49.4-14.1c-18.3-11.3-33.4-24.2-24.4-48.7M206 45.4c-3.4 27.2-10.8 51.2-46.9 52.1c27.4 3.1 44.3 19.1 46.9 52.2c2.3-26.1 14.6-45.7 46.8-52.2c-34.1-4.7-48-23.2-46.8-52.1M85.7 101.2c-5.5 22-19 32.5-43.2 27.8c20.4 12.6 24.5 30.3 20.4 50.6c9-24.3 24-32.3 43.4-28c-24.4-9.4-24.2-29.2-20.6-50.4m310.4 0.8c3.6 21.2 3.8 41-20.5 50.4c19.3-4.3 34.3 3.7 43.3 28c-4.1-20.2 0-38 20.4-50.6c-24.2 4.7-37.7-5.8-43.2-27.8m-139.4 52c-9.6 0-18.1 2.4-23.7 5.8c-5.5 3.4-7.3 6.7-7.3 9.3s1.8 5.9 7.3 9.3c5.6 3.3 14.1 5.7 23.7 5.7c3.9 0 7.7-0.4 11.1-1.1c5.5-6.1 12.5-10.2 19.7-12.6c0.6-4.9-4.7-9.1-7.1-10.6c-5.6-3.4-14.1-5.8-23.7-5.8m-45.1 28.2c-6.2 0.9-9.1 3.1-10.2 5.4c-1.9 12.5 13 22.2 22.1 26.5c8.7 3.9 17.5 5.2 23.9 4.5s9.4-3.1 10.5-5.4c1.1-2.4 0.8-6.1-2.6-11.1c-12-0.2-22.8-3.1-31.5-8.3c-4.9-3-9.3-6.9-12.2-11.6m98.6 2.6c-9.6 0-18.1 2.4-23.7 5.7c-5.5 3.4-7.3 6.7-7.3 9.3s1.8 5.9 7.3 9.3c5.6 3.3 14.1 5.7 23.7 5.7s18.1-2.4 23.7-5.7c5.5-3.4 7.3-6.7 7.3-9.3s-1.8-5.9-7.3-9.3c-5.6-3.3-14.1-5.7-23.7-5.7m48.8 12.3c5.1 10.4-10.3 23.8-17.6 28.4c1.4 0.7 3.2 1.3 5.5 1.8c6.4 1.2 15.2 0.6 24.2-2.7c7.7-2.8 14.1-7 18.4-11.3c0.4-5.7 1.2-11 4.7-15c-10.5-6.9-24.8-5.1-35.2-1.2m-202-1.5c-9.6 0-18.1 2.4-23.7 5.7c4.6 6.3 5.7 13.2 4.5 20.8c5.2 2.1 11.9 3.5 19.2 3.5c9.6 0 18.1-2.4 23.7-5.7c5.5-3.4 7.3-6.7 7.3-9.3s-1.8-5.9-7.3-9.3c-5.6-3.3-14.1-5.7-23.7-5.7m251.1 14.2c-2.7 12.2 11.8 23 20.5 27.7c8.5 4.4 17.1 6.2 23.6 5.9c6.4-0.4 9.6-2.5 10.8-4.8s1.2-6.1-2.2-11.6s-9.8-11.6-18.3-16.1c-6.5-3.1-28.9-11.1-34.4-1.1m-302.5-0.9c-5.9-0.1-13.1 1.2-20.3 4.2c-8.8 3.7-15.7 9.2-19.5 14.4c-3.8 5.3-4.2 9-3.2 11.4s4 4.8 10.4 5.8c6.3 0.9 15.1-0.2 24-4c8.9-3.7 15.8-9.2 19.6-14.4c3.8-5.3 4.2-9 3.2-11.4c-4.3-4.9-8.5-6-14.2-6m168 13.1c-3.1 5.8-8.3 9.8-14.4 12.1c6.4 3.9 11.5 9.7 13.1 17.2c2.2 10.5-3 20.4-10.7 27.5c-7.7 7.2-18.2 12.4-30.5 14.9c-12.2 2.6-24 2.1-33.9-1.3s-18.6-10.4-20.8-20.8c-2.2-10.5 2.9-20.4 10.6-27.5c7.1-6.6 16.7-11.6 27.7-14.3c-4.4-2-8.4-4.4-12-7.1c-2.9 5.2-7.5 9.4-12.8 12.6c-9 5.4-20.4 8.3-32.9 8.3c-9.9 0-19.1-1.8-27-5.3c-6.1 7.9-15.2 14.5-26 19c-10.5 4.4-21 6.3-30.6 5.5c-3.8 7.5-11.4 12.4-19.6 15c-10.1 3.1-21.9 3.2-34 0.2c-0.3-0.1-0.6-0.1-0.8-0.2V324c2.8-1.5 5.9-2.6 9-3.3c3.4-0.8 7-1.2 10.7-1.3v-0.2c-2.9-10.3 1.7-20.5 8.9-28.1s17.4-13.5 29.5-16.8c11.6-3 23.1-3.7 33.9-0.8c10.1 2.8 19.3 9.2 22.1 19.5c2.9 10.3-1.6 20.5-8.9 28.1c-7.2 7.6-17.4 13.4-29.5 16.8c-1.8 0.5-3.7 0.9-5.6 1.3c7.5 8.4 11.8 21.7 9.3 30.2c-3.3 10.1-12.7 16.1-22.9 18.5c-10.3 2.4-22 1.6-33.9-2.2c-8.7-2.8-16.4-6.9-22.6-12.1v113.9h77.2c-4-10.7 3.9-11.4-7.2-16.1c-11.6-4.7-21-11.8-27.3-20.2s-9.5-19.1-5.5-29c4.1-9.8 13.9-15.1 24.3-16.7c10.4-1.5 22.1 0.1 33.6 4.9c11.6 4.7 21 11.8 27.3 20.2c2.3 3.1 4.2 6.4 5.5 9.9c8.4-0.6 16.4 0.4 23.5 2.8c9.9 3.4 18.6 10.4 20.8 20.8c1.8 8.6-1.3 16.8-6.7 23.4h256.1c-6.3-7.3-10-16.6-7.4-26.2c2.8-10.3 11.9-16.7 22-19.6s21.9-2.7 33.9 0.6c1.7 0.5 3.3 1 4.9 1.6V342.7c-11 1.8-21.6 1.1-30.6-2c-9.9-3.4-18.6-10.4-20.8-20.8c-2.2-10.5 2.9-20.4 10.6-27.5c13.2-10.1 25.8-15.4 40.8-16.3V275c-15 0.2-35.9-5.5-44.9-13.6c-9.3-0.2-19.2-2.9-28.9-8c-10.7-5.6-19.1-13.1-24.6-21.7c-5.3 4-11.5 7.3-18.3 9.8c-11.8 4.3-23.5 5.5-33.8 3.5c-8.6-1.7-16.7-5.9-21.3-13.1c-3.8 0.6-7.9 0.9-12 0.9c-12.5 0-23.9-2.9-32.9-8.3c-1.3-0.8-2.5-1.6-3.7-2.5m207 5.9c1.9 11.1 0.3 19.9-8 26.7c7.8 2.2 14.2 2.9 21.4 2.4v-29.6c-4.5-0.3-9.3-0.2-13.4 0.5M18 229.7v28.9c9.4 3.2 21.2 4.7 30.4 2c3.3-1 5.5-2.2 7-3.6c-7.2-5.3-11.2-12.3-11.3-20.7c-3.7-2-8-3.7-12.8-4.9c-4.6-1.1-9.2-1.7-13.3-1.7m203.2 17.1c-9.4 2-17.2 6.1-22 10.4c-4.7 4.5-5.7 8.1-5.2 10.7c0.5 2.5 3 5.4 9.1 7.5s14.9 2.7 24.3 0.7s17.2-6.1 22-10.4c4.7-4.5 5.8-8.1 5.3-10.6c-0.6-2.6-3-5.4-9.1-7.6c-8.3-2.4-16.6-2.4-24.4-0.7M81.9 291.6c-9.3 2.6-16.9 7.2-21.3 11.8c-4.4 4.8-5.3 8.4-4.6 11c0.7 2.5 3.3 5.1 9.6 7c6.1 1.7 15 1.7 24.3-0.9c9.2-2.5 16.9-7.1 21.3-11.8s5.3-8.4 4.6-10.9s-3.4-5.2-9.6-7c-7.9-2-16.8-1.3-24.3 0.8m261 0.1c6.5 0.1 12.6 1.1 18.2 3c10 3.5 18.7 10.4 20.9 20.9c1 4.9 0.4 9.8-1.4 14.3c9.9 3.4 18.3 8.6 24.6 15c7.2 7.6 11.8 17.8 9 28.1s-11.9 16.8-22 19.6c-10.1 2.9-21.8 2.7-33.9-0.6c-12.1-3.2-22.3-9-29.6-16.6c-4.4-4.6-7.9-10.1-9.2-16.1c-4.4-0.4-8.7-1.3-12.6-2.7c-9.9-3.4-18.6-10.3-20.8-20.8s3-20.3 10.7-27.5c7.6-7.1 18.2-12.3 30.4-14.9c5.4-1.1 10.6-1.7 15.7-1.7m151.1 2.4c-2.2 0.2-4.4 0.5-6.6 1c-9.4 2-17.2 6.1-22 10.4c-4.7 4.5-5.7 8.1-5.2 10.7c0.5 2.5 3 5.4 9 7.5c6.2 2.1 15 2.7 24.4 0.7c0.1 0 0.3-0.1 0.4-0.1zM330.9 311c-9.3 2-17.2 6.1-22 10.5c-4.6 4.4-5.7 8-5.2 10.6c0.5 2.5 3 5.4 9.1 7.6c6.1 2.1 14.9 2.7 24.3 0.7s17.3-6.1 22-10.5c4.7-4.5 5.8-8.1 5.3-10.6c-0.6-2.5-3-5.4-9.1-7.6c-8.3-2.4-16.6-2.4-24.4-0.7m-133.4 5.7c12.2 2.6 22.7 7.9 30.4 15.1c7.6 7.2 12.8 17.1 10.5 27.5c-2.3 10.5-11 17.4-21 20.8c-9.9 3.3-21.7 3.8-33.9 1.1c-12.2-2.6-22.7-7.9-30.4-15c-7.6-7.2-12.8-17.1-10.5-27.6s11-17.4 21-20.7c11.5-3.6 23-3.4 33.9-1.2m-28.2 18.2c-6.1 2.1-8.6 5-9.1 7.5c-0.6 2.6 0.5 6.2 5.2 10.6c4.7 4.5 12.5 8.6 21.9 10.6c9.4 2.1 18.2 1.5 24.4-0.5c6.1-2.2 8.5-5 9.1-7.6c0.5-2.5-0.5-6.1-5.2-10.6c-4.8-4.4-12.6-8.6-21.9-10.6c-8-1.5-16.7-1.8-24.4 0.6M32 338.2c-6.2 1.5-9 4.1-9.8 6.6s-0.1 6.1 4.1 11.1c4.3 4.8 11.7 9.7 20.8 12.7c9.2 2.9 18 3.3 24.3 1.8s9-4.1 9.8-6.6c0.8-2.4 0.1-6.1-4.1-11.1c-4.3-4.8-11.6-9.7-20.8-12.7c-8.3-2.3-16.4-3.4-24.3-1.8m336.9 7c-10.3 6.9-20.1 11.5-30.6 13.3c5.3 8.5 16.8 14 24.7 16.2c9.3 2.5 18.1 2.4 24.4 0.7c6.2-1.9 8.8-4.6 9.5-7.1c0.6-2.5-0.2-6.2-4.7-10.9c-7.7-6.2-15.2-10.4-23.3-12.2m-53.7 34.9c9.9 3.4 18.6 10.3 20.8 20.8s-3 20.4-10.7 27.5c-7.6 7.1-18.2 12.3-30.4 14.9c-12.3 2.6-24 2.1-33.9-1.3c-10-3.5-18.7-10.4-20.9-20.9c-2.2-10.4 3-20.3 10.7-27.5c7.7-7.1 18.2-12.3 30.4-14.9c11.1-2.3 23.6-2.2 34 1.4M285 396.3c-9.4 2-17.3 6.1-22 10.5c-4.7 4.5-5.8 8.1-5.3 10.6c0.6 2.6 3 5.4 9.1 7.6c6.1 2.1 15 2.7 24.4 0.7c9.3-2 17.2-6.1 22-10.5c4.6-4.4 5.7-8 5.2-10.6c-0.5-2.5-3-5.4-9.1-7.6c-8.1-2.3-16.3-2.3-24.3-0.7m-201.8 27c-6.4 1-9.3 3.4-10.3 5.8s-0.6 6.1 3.2 11.4c3.9 5.2 10.9 10.6 19.7 14.3c9 3.6 17.7 4.6 24.2 3.7c6.3-1 9.3-3.4 10.3-5.8c0.9-2.4 0.5-6.1-3.3-11.4c-3.9-5.2-10.8-10.6-19.7-14.3c-8.2-2.8-16.1-4.7-24.1-3.7m387.9 34.5c-6.5 0.1-18.5 1-20.5 8.2c-0.1 12.5 16 19.8 25.6 22.5H494v-25.3c-7.3-3.4-15.2-5.2-22.9-5.4m-323.8 0.8c-4.3 9.9-16.3 16.3-24.7 17.7c-3 0.4-6.1 0.6-9.3 0.5c-1.9 6.1 5.6 10.3 9.7 11.7h25.2c8.6-2 15.7-6 20.1-10c4.7-4.5 5.9-8.1 5.3-10.6c-0.5-2.6-3-5.4-9.1-7.6c-6.2-1.6-11.4-2.4-17.2-1.7",
  "crossed-swords":"M19.8 14.4c59.5 112.3 142.5 202.3 232.3 292.7l3.6 3.8l0.1-0.1c21.8 21.9 44 43.9 66.4 66.2c-18.9 14.8-39 28.2-59.9 40.3l28.5 28.5l68.7-68.7c42.3 27.6 76.3 63.6 104.1 105.8l28.1-28.1c-42.5-27.5-79.7-60.2-106-103.9l68.9-68.9l-28.5-28.5c-11.1 21.9-24.4 42-39.5 60.6c-43.9-43.8-86.5-85.8-130.1-125.5c-0.2-0.2-0.4-0.4-0.7-0.6C183.6 122.8 108.5 63.9 19.8 14.4zm471.9 0c-83 46.3-154.1 100.8-222 161.2l22.8 21.6l56.8-56.8l13.2 13.2l-56.4 56.4l24.6 23.2c61.8-66.9 117.6-136.9 161-218.7zm-329.5 125.9l200.6 200.5a403 403 0 0 1-13.4 13L148.9 153.5zm-76.7 113.3l-28.5 28.5l68.9 68.9c-26.3 43.7-63.5 76.4-106 103.9l28.1 28.1c27.8-42.2 61.8-78.2 104.1-105.8l68.7 68.7l28.5-28.5c-21-12.1-41.1-25.5-59.9-40.3c17.9-17.8 35.6-35.4 53.2-53l-24.8-25.7l-55.5 55.5c-4.6-4.2-9-8.6-13.4-13.1l55.8-55.8l-24.5-25.4c-18.3 17.9-36.6 36.1-55.2 54.6c-15.1-18.6-28.4-38.8-39.5-60.6z",
  "crown-coin":"M256 68.8c-65.9 0-125.2 18.6-167.7 47.9c-42.5 29.3-67.7 68.9-67.7 111.9s25.2 82.5 67.7 111.9C130.7 369.8 190.1 388.4 256 388.4c65.8 0 125.3-18.6 167.8-47.9c42.3-29.4 67.6-68.9 67.6-111.9s-25.3-82.6-67.6-111.9C381.3 87.4 321.9 68.8 256 68.8m3 21.2l-0.2 18.7c-6-0.1-12 0.2-18 0.5l-1.2-18.7c6.5-0.3 12.9-0.5 19.4-0.5m19 0.6c6.4 0.4 12.9 0.9 19.3 1.8L295 110.9c-5.9-1-11.3-1.1-17.9-1.7zm-57.6 1.6l2.3 18.6c-6 0.6-12 1.7-18 2.7l-3.3-18.4c6.6-1.2 13.5-2.1 19-2.9m96.1 3.2c6.3 1.3 12.6 2.6 18.8 4.4l-4.8 18c-5.8-1.5-11.8-2.8-17.7-3.9zM187 117.3c-5.9 1.6-12 3.4-17.3 5.1l-6.3-17.7c6-1.9 13.3-4.2 19.3-5.8c1.6 6 2.9 12.5 4.3 18.4m166.7-11.9c6.1 2.1 12.3 4.3 18.2 6.9l-7.4 17.2c-5.5-2.5-11.2-4.4-16.8-6.5zm-208 6.1l7.3 17.1c-6.1 2.8-10.8 4.8-16.2 7.7l-8.7-16.6c6.4-3.5 11.2-5.5 17.6-8.2m243.6 9.2l0.1 0.1c5.9 3.3 12 6.7 16.8 10l-10.3 15.6c-4.9-3.3-10-6.3-15.2-9.1l-0.1-0.1c3.1-5.4 5.8-11 8.7-16.5m-278 8.8c3.3 5.3 6.6 10.5 10.1 15.7c-5 3.2-9.7 6.7-14.3 10.4l-11.8-14.5c6.5-7 12.8-10.3 15.9-11.6M422 142.6c5 4.4 10.1 8.6 14.5 13.7l-13.8 12.6c-4.3-4.3-8.6-8.7-12.7-12zM94.2 167.5c-4.1 4.4-8 9.2-11 13.4L68 170c4.8-6.1 8.1-10.7 12.9-15.5c3.6 3.9 9 8.9 13.3 13m172.2-8.7c13.4 23.7 25.1 48.6 37.3 73l-37.3-44.1l-27.4 32.3l-15.7-10.2c14.4-17 28.7-34 43.1-51m-141.7 11.8c33.8 17 66 40.5 98 61.1l-68.3-28.4l26.4 85.4l85.6 6.3l85.9-6.3l-9.4 19.4l-76.5 5.6l-99.6-7.3zm284.2 0.1c-17.8 38.5-36.6 76.7-55.1 114.9l25.5-82.4l-57.2 23.6l-8.5-16.8zm39.9 1.3c3.7 5.7 7.1 12 9.9 17.6l-17 7.8c-2.3-5.3-5.4-10.1-8.3-15zM57.8 187.7l17 7.8c-2.5 5.1-4.2 10.5-5.6 16l-18-4.8c1.8-7.9 3.6-12.8 6.6-19m407.4 21.6c1.1 7.2 2.1 14 2.1 20.7l-18.7-0.3c-0.4-5.7-0.6-11.6-1.7-16.4c6.1-1.3 12.2-2.7 18.3-4M67 227.9c0.1 5.8 0.7 11.5 1.6 16.4l-18.3 3.9c-0.9-7-1.7-14.3-1.7-20.7c4.5 0.1 12.8 0.3 18.4 0.4m379.6 18.5l18.2 3.9c-1.5 6.9-4.1 14.1-6.6 19.6l-17-7.8c2.3-5.5 4.1-10.9 5.4-15.7M73.5 260.5c2.5 5.2 5.2 10.3 8 14.8l-15.5 10.4c-4.2-6.4-7.1-12-10.1-18c5.4-2.5 11.6-5 17.6-7.2M432.7 277l15.5 10.5c-3.9 5.7-8.6 11.4-12.5 15.8c-4.8-4.6-9-8.6-13.7-12.9v-0.1c4.1-4.5 7.8-9.2 10.7-13.3m-328 24l-11.9 14.3c-5.2-4.3-10.4-9.4-14.5-13.8l13.8-12.6c4.3 4.1 8.7 8.8 12.7 12.1m-83.2-3.5c1.7 12.9 5.6 25.3 11.5 37.1v-20.3c-4.2-5.4-8-11-11.5-16.8m468.9 0c-4.4 7.5-9.6 14.7-15.3 21.5v22.7c8.1-14 13.3-28.8 15.3-44.2m-81.1 4.8l11.7 14.5c-6.1 4.9-9.9 7.7-15.8 11.6l-10.3-15.6c5-3.2 9.7-6.8 14.4-10.5m-290.5 9.3c4.9 3.4 10.1 6.4 15.3 9.3l-9 16.4c-5.8-3-11.2-6.7-16.7-10.1zm260.8 10.2l8.7 16.6c-5.7 3.1-11.5 5.7-17.5 8.3l-7.4-17.2c5.7-2.3 11.5-5.2 16.2-7.7M150 328.7c5.4 2.5 11.2 4.3 16.8 6.5l-6 17.7c-6.1-2-12.1-4.6-18.1-7zm-98.2 6.2v27.8c5.1 5.9 10.7 11.7 16.8 17.1v-30.6c-5.9-4.6-11.5-9.3-16.8-14.3m294.9 1l6.1 17.7c-6.3 2.1-13.1 3.9-18.6 5.5l-4.8-18.1c6.2-1.4 11.9-3.6 17.3-5.1m109.8 2.5c-5.3 4.7-10.8 9.3-16.7 13.6v31.1c6-5.1 11.6-10.5 16.7-16.1zM184 340.5c5.8 1.5 11.7 2.8 17.6 4l-3.5 18.4c-6.4-1.2-12.6-2.8-18.8-4.4zm127.7 4.4l3.6 18.4c-6.6 1.1-13.4 2.3-19.1 2.9l-2.3-18.5c6.4-1.1 12-2 17.8-2.8m-92.2 2.5c6 0.8 12 1.4 18.1 1.8l-1.3 18.6q-9.6-0.6-19.2-1.8zm56.4 1.9l1 18.7c-6.8 0.5-14.3 0.8-21.4 0.5l0.1-18.6c6.8 0 13.5-0.2 20.3-0.6M87.2 362.1v32.5c6.4 4.5 13.6 8.9 19.4 12.2v-33.7c-6.8-3.4-13.2-7.1-19.4-11M421 364.4c-6.3 3.8-12.8 7.3-19.6 10.6v33.9c6.9-3.7 13.4-7.6 19.6-11.7zm-295.6 17.4v34.5c6.7 3 13.7 5.9 20.9 8.5v-35.1c-7.1-2.4-14.1-5-20.9-7.9m257.3 1.6c-6.8 2.7-13.8 5.2-20.9 7.5v35.2c7.2-2.5 14.2-5.2 20.9-8.1zM165 395.3v35.5c6.6 1.9 13.4 3.6 20.3 5.1v-35.8c-6.9-1.4-13.7-3-20.3-4.8m178.1 1c-6.6 1.7-13.4 3.2-20.3 4.5v35.8c6.9-1.4 13.7-2.9 20.3-4.7zm-139.1 7v36c6.8 1.1 13.8 1.9 20.9 2.6v-36.2c-7.1-0.6-14.1-1.4-20.9-2.4m100.3 0.5c-7.4 1-14.8 1.8-22.4 2.3v36.2c7.6-0.6 15-1.4 22.4-2.4zm-60.7 3V443c7 0.3 12.5 0.2 19.5 0.2V407c-6.5 0-13.8 0.1-19.5-0.2",
  "crown-of-thorns":"M255.1 24.9c-16.7 9.4-34.5 42-41.7 59.5c-14.6-2.4-28.9-3.7-42.6-3.8c-11.4-0.1-22.5 0.7-33 2.2c-16.3-8.3-34.8-29.1-42.6-50c-9.3 15.7-9.6 42.3-5.8 64.6c-19.4 9.7-35.1 23.6-45.5 41.7c-7.3 12.6-11.5 26.3-13 40.9c13.3-25.9 35-47 65.7-54.3c-35 31.8-59.9 87.2-51.5 129.4c-1.2 22.9-9.5 37.6-24.8 44.6c16.3 4.6 35.5 3.3 49.4-1.3c24.9 34.8 60.8 67.9 105.1 94.3c-7 17.6-16.7 49.2-16.5 66c10.8-13.2 37.4-40.6 61.7-42.8c23.7 10.3 47.4 17.7 70.3 22.3c12.4 17.2 12.9 38.9 7.4 53.6c16.4-9.2 33.8-33.2 39.9-48c47.1 1.4 88-10.5 114.7-35.6c17.5 5.5 30.7 15.7 39.8 30.5c0.2-19.6-8.1-44.4-18-60.3c13.4-28.3 12.8-61.8 0.5-96.2l0.4 0.5c10-11.8 18.3-33.2 18.1-52.9c-8.5 10.4-20.7 15.1-36.8 14.2c-13.6-22.6-31.8-44.8-54-65.4c10.6-19.3 30.4-36.4 44.2-48c-19-5.3-67.8 5.2-80.8 17.8l5.9 8.5c5.6 12 9.5 24.4 11.1 37.1c-26.3-37.3-70.7-74.7-114.9-95.6c-15.9-25.4-19.3-56.1-12.8-73.6zm-82.9 97.1c1.1 0 2.3 0 3.4 0c31.6 0.2 68.9 8.8 107 25.7c-8.8 20.1-14.7 44.5-10 61.3c13.3-18.6 37.3-34.2 55.4-37.5c55.9 34.3 96.2 78.7 111.7 118.7l0.1 0.2c16.1 37.9 13.4 85.2-26.6 117.3c4.8-11.4 8-23.8 9.5-36.4c-14.1 10-33.5 15.3-56.3 16c-2-17.2-9.1-52.9-22.3-65.7c1.6 16.1-8.1 46.3-26.2 61.1c-31.9-6.5-66.8-19.7-101-39.4a381 381 0 0 1-27.3-17.3c-3.4-23.6 7.8-53.6 20.6-64c-19-0.2-46.7 22.2-59.3 32.8c-41-38.5-64.1-81.1-61.2-115c16.3-1.7 36.1 0.9 51.7 8c-3.9-15.4-18.6-31.7-34.4-44.3c14.8-13.8 37.7-20.9 65.3-21.2z",
  "crowned-explosion":"m62.8 19.3l90.1 94.6a174 174 0 0 0-21.2 16.3l-65.6-22l32.9 61.5a173 173 0 0 0-18.9 44.6c-4.9 18.1-6.6 36.4-5.7 54.2L21.2 308.4l62.6 7.6a175 175 0 0 0 8.3 19.8L19.2 366.8v95.9l90.6-98.4a174 174 0 0 0 20.3 22.4l-22.6 53.1l61.3-26.1a173 173 0 0 0 23.1 9.7l-42.3 71.2h104.4l-7.1-62.1a172 172 0 0 0 27.6-2.1l34 50.5l14.5-65.7a174.6 174.6 0 0 0 37.5-24.6l57 19.4l-23.4-58.2a172 172 0 0 0 9.6-17.4l90.7 63.1V283l-75.7 2.8a172 172 0 0 0 2-22l62-36l-68.3-15.3c-8.7-31-25.9-59.1-49.6-81l112.8-112.2h-92.9l-42.3 94.8a172 172 0 0 0-20.8-11.6l-8.2-67l-39.4 52.4a172.3 172.3 0 0 0-33.5-1.9a172.5 172.5 0 0 0-42.6 7.1l-15-73.7H62.8zm184.2 85.1c13.4 0 27 1.7 40.5 5.3c17.3 4.6 33.2 12 47.2 21.6l-24.2 54.1l41-40.8a154.7 154.7 0 0 1 23.3 26.7l-30.9 41.9l50.5-2.3c7.8 23.7 9.9 49.6 5.2 75.6l-61.4 2.2l49.8 34.7c-25.6 56.3-82.3 91.6-143.4 90.4l-7.6-66.7l-35.5 59.7c-33-10.2-60.2-30.5-79.2-56.5l41.5-45.1l-54.8 23.3a155 155 0 0 1-11.3-29.9l58.7-32.4l-62.7-25.3a156.6 156.6 0 0 1 4.2-21.8c10.6-39.6 35.6-71.5 67.9-91.5l49.7 52.1l-13.9-68.4a153.9 153.9 0 0 1 45.3-6.9zm5.2 82.9c-39.5 0-71.6 32.1-71.6 71.6c0 39.5 32.1 71.6 71.6 71.6s71.6-32.1 71.6-71.6c0-39.5-32.1-71.6-71.6-71.6z",
  "crowned-skull":"m92.4 13l-0.2 156.4c3.1 0.5 6.2 1.4 9.4 2.6c36.5 14.3 74.2 22.4 111.9 25.5l43.4-60.4l42.3 58.9c36.8-4.1 72.6-12.5 106-24.1c3.8-1.3 7.4-2.2 10.8-2.6l1.5-156.3l-75.8 95.6l-34.1-95.5l-53.7 103.7l-53.7-103.7l-35.4 95.5l-72.3-95.5h0zm164.5 156.1l-28.6 39.9l28.6 39.9l28.6-39.9zM86.8 187.6c-2.2-0.1-3.8 0.3-5 0.8c-2.3 1-3.2 2.2-3.5 4.2c-0.6 4 2.8 14.3 23 21.4c41.7 14.5 84.3 23.7 126.8 26.8l-17.8-24.7c-38.8-3.3-77.7-11.8-115.5-26.6c-3.2-1.3-5.9-1.8-8.1-1.9zm333.3 0.2c-2.2 0.1-5 0.5-8.7 1.8c-33.6 11.7-69.5 20.2-106.5 24.6l-19.3 26.8c40.4-2.6 80.4-11.3 119.2-27c15.9-6.4 21.5-17.8 21.4-22.4c-0.1-2.3-0.3-2.6-1.8-3.3c-0.7-0.4-2.2-0.7-4.3-0.7zm-18.1 47.4c-42.5 15.9-86.3 23.9-130.3 25.1l-14.8 20.5l-14.9-20.7c-45-1.7-90-10.2-133.9-24.3c-12.8 28.5-18.9 61.1-19.6 93.4c37.5 17.5 62.1 39.8 75.6 64.6C177 417.8 179.3 443.6 174.2 468c7.7 5 16.1 9.1 25 12.4l5.6-47.9l18.6 2.2l-5.9 51.2c9.6 2.2 19.4 3.5 29.4 4v-54.7h18.7v54.5c9.9-0.6 19.7-2.1 29.2-4.5l-5.9-50.5l18.6-2.2l5.4 46.9c8.7-3.4 17-7.6 24.5-12.7c-5.8-24.4-3.8-49.7 9-73c13.3-24.2 37.7-46 74.8-64.3c-0.6-33.5-6.7-66.1-19.1-94.2zm-266.7 47c34.6 0.2 68.4 12.2 101.4 36.9c-46.6 33.1-129.8 34.4-108.3-36.8q3.5-0.1 6.9-0.1zm242.8 0q3.5 0 6.9 0.1c21.5 71.1-61.7 69.9-108.3 36.8c33-24.6 66.8-36.6 101.4-36.9zM255.2 332.1c11.8 21.7 19.2 43.5 25.4 65.2h-50.7c4.6-21.7 13.8-43.5 25.4-65.2z",
  "daemon-skull":"M142 16.9C94.2 38.9 62.7 74.3 62.7 113.9c0 26.1 13.4 50.3 36.2 70c-11.7 25.4-19 53.9-20.8 84.2c17.2 0.6 33.5 4.2 48.2 11.7c41.6 21.2 61.1 66.9 57.8 121.1a287 287 0 0 0 23.1 4.6c0.9-16.8 0.8-33.5-0.5-50.1l18.6-1.5c1.4 18 1.5 36 0.5 53.9c8 0.8 16.1 1.2 24.3 1.4V353h18.7v56.1c7.8-0.2 15.7-0.8 23.6-1.5c-1-17.8-1-35.7 0.5-53.7l18.6 1.5c-1.3 16.6-1.4 33.2-0.5 50c7.3-1.1 14.6-2.4 21.9-3.8c-3.5-54.4 16-100.3 57.7-121.7c14.7-7.5 31-11.1 48.2-11.7c-1.8-30.7-9.3-59.6-21.3-85.3c22.1-19.6 35-43.3 35-69c0-39.7-31.5-75-79.3-97C386.3 33.5 394.3 53.3 394.3 74.3c0 42.7-31.5 79.6-77 97.1l-6.1-14.3c11.1-4.4 21.2-10.2 29.9-17c10.1-7.9 18.2-17.1 23.9-27.2c-29.9-25.3-66.6-40.3-106.5-40.3c-40.3 0-77.6 15.3-107.6 41.2c5.7 9.7 13.6 18.6 23.4 26.2c9.7 7.6 21.1 13.9 33.9 18.5l-6.1 14.3c-47.7-16.9-81.1-54.7-81.1-98.6c0-21 8-40.8 21.1-57.4zm10.3 183.1c0.1 0 0.1 0 0.1 0c18.4 23.4 51.9 39.7 91.1 43.2c-5.9 19.7-27 34.5-52.7 34.5c-30.2 0-55.1-20.6-55.1-45.5c0-12.5 6.2-24 16.1-32.2c0.1 0.1 0.3 0 0.5 0zm211.7 0c0.1 0 0.1 0 0.1 0c9.9 8.2 16.1 19.7 16.1 32.2c0 24.9-24.9 45.5-55.1 45.5c-25.7 0-46.8-14.8-52.7-34.5c39.2-3.5 72.7-19.8 91.1-43.2c0.1 0.1 0.3 0 0.5 0M258.4 244.2c5.6 27.4 13.9 54.8 32.9 82.3c-20.3 5.4-44.8 5.6-65.8 0c18-27.4 26.8-54.8 32.9-82.3m-76.3 175.5c-2.3 15.4-6.4 31.3-12.2 47.4a169 169 0 0 0 27.7 14.6c3.6-19.2 6.5-38.4 8.3-57.5a309 309 0 0 1-23.7-4.6zm152.8 0.5a409 409 0 0 1-22.5 3.9c1.8 19 4.7 38 8.2 57.1a169 169 0 0 0 26.5-14.1c-5.8-15.9-9.8-31.6-12.2-46.9zm-41.1 6.1c-8.3 0.8-16.7 1.3-25 1.6v65.7a158 158 0 0 0 34-6c-3.9-20.3-7.1-40.8-9-61.3zm-69.4 0.2c-2 20.5-5.1 41-9 61.4a158 158 0 0 0 34.8 5.8v-65.7a349 349 0 0 1-25.7-1.4",
  "death-skull":"M256 16c-120 0-240 60-240 150C16 226 61 256 61 316c0 45-15 45-15 75c0 15 48 32 90 45v60h240v-60s90.6-28 90-45c-0.9-27.9-15-30-15-75c0-30 45.6-91.4 45-150c0-90-120-150-240-150m-90 180c33.1 0 60 26.9 60 60s-26.9 60-60 60C132.9 316 106 289.1 106 256s26.9-60 60-60zm180 0c33.1 0 60 26.9 60 60s-26.9 60-60 60s-60-26.9-60-60s26.9-60 60-60m-90 105c15 0 45 60 45 75c0 30 0 30-15 30h-60c-15 0-15 0-15-30c0-15 30-75 45-75",
  "diamond-trophy":"m158.6 41l34.5 69.1L239.2 41zm114.2 0l46.1 69.1L353.4 41zM256 48.2L208.8 119h94.4zm-113.9 0.1L83.2 119h94.2zm227.8 0L334.6 119h94.2zM80.8 137L196.8 311H249l-63.4-174zm124.1 0L256 277.7L307.1 137zm121.5 0L263 311h52.2l116-174zM201 329v46h110v-46zm-67.8 64l-53.7 94H432.5l-53.7-94H183zm26.8 46h192v18H160z",
  "dice-eight-faces-eight":"M256 37.1L77.9 343.9h356.2zM230.2 49.8L72 164.2v157.9zm51.7 0L440 322.1V164.2zm-132.5 90v21.8l-8.5 9.7v-16.9c-2.8 3.2-5.7 6.4-8.4 9.7c3.5 0.3 2.5 5.4 2.2 7.8c-1.7 9.5-8.2 17.6-13.4 24.8c-1.9 2.5-3.9 5.1-6 7.5c-4.7 3.4-8.5 4.4-10.8-1.5c0.3-7.8 3.8-15.2 8-21l5.3-7.9c0 2.5 0.1 5-0.1 7.4c-2.3 4.3-6.8 9.5-5.8 14.6c7.8 0.9 12.2-10.9 14.5-16.6c0.8-2.8 2.1-5.5-1.4-5.4v-7.3zm212.1 1.2l44.9 54.5v7.3l-30.3-36.3v8.5l-6.1-7.3c-0.2-4.2-1.4-8.4-2.4-12.1c-1.9-2.9-4-5.7-6.1-8.5zM256.1 203.9q12.6 0 19.1 4.6q6.5 4.5 6.5 13.3q0 5.9-3.2 9.8q-3.2 3.9-9.5 5.8q7 1.9 10.6 6.3q3.6 4.4 3.6 11q0 10.3-6.9 15.6q-6.8 5.2-20.2 5.2q-13.5 0-20.4-5.2q-6.9-5.3-6.9-15.6q0-6.7 3.6-11q3.6-4.4 10.7-6.3q-6.3-1.9-9.5-5.8q-3.2-3.9-3.2-9.8q0-8.8 6.5-13.3t19.2-4.6zm0 11.2q-4.3 0-6.6 2.2q-2.3 2.2-2.3 6.3q0 4.1 2.3 6.3q2.3 2.2 6.6 2.2q4.2 0 6.4-2.2q2.3-2.2 2.3-6.3t-2.3-6.3q-2.3-2.2-6.4-2.2m0 28.3q-5 0-7.7 2.7q-2.7 2.7-2.7 7.8q0 5.1 2.7 7.8q2.7 2.7 7.7 2.7q5 0 7.6-2.7q2.6-2.7 2.6-7.8q0-5.1-2.6-7.8q-2.6-2.7-7.6-2.7zM88.7 359.9L256 480.9l167.3-121.1zm139.4 23.2h54.5v4.8c-14.4 5.9-21.6 12.9-27.9 25.4h-15.8c7.1-13.8 14.5-17.7 26.7-25.4h-37.6z",
  "dice-fire":"M218.4 24.7c-14.2 0-30.5 3.6-49.5 11.9c77.2 8.6 65.9 91.4 14.1 106.2c-65.4 18.7-131.3-23.7-98.3-99.2c-39.7 18.9-42.2 80.8-12.9 111.5C141.3 227.9 56.9 279 37.2 200.7C-1.9 326.2 60.3 489.5 258.7 489.5c250.7 0 282-374.7 129.2-415c26.5 43-13.1 70.9-24.9 73.1c-51.3 9.9-58.1-122.9-144.6-122.9m37.5 118.1c4.5 0 9.4 1.1 12.8 2.9l115.9 67.1c7.4 4.1 7.4 10.9 0 15.2l-115.9 66.9c-7.2 4.3-18.5 4.3-25.7 0L126.8 228c-7.3-4.3-7.3-11.1 0-15.2L243 145.7c3.4-1.8 7.9-2.9 12.9-2.9m-89 62.6c-21.6-0.4-33.1 15-18.2 24.3c9.6 4.8 23.7 4.4 32.7-0.8c8.8-5.3 9.5-13.7 1.5-19.4c-4.3-2.5-10-4-16-4.1m178.6 0.1c-20.8 0.4-31.3 15.5-16.3 24.5c9.6 4.9 23.9 4.6 33-0.7c8.9-5.3 9.5-13.9 1.2-19.6c-4.2-2.4-9.9-4-15.9-4.2zm-89 0c-6.6-0.1-13 1.5-17.7 4.2c-10.2 5.6-10.4 15.1-0.6 20.9c9.9 5.8 25.8 5.6 35.1-0.6c15-9 4.6-24.3-16.8-24.5m-141 41c1.5 0.1 3.4 0.5 5.6 1.6l111.5 64.5c7.2 4.1 12.9 14.2 12.9 22.5v119.7c0 8.3-5.7 11.7-12.9 7.6L121.2 398c-7.4-4.3-13.2-14.2-13.2-22.6V255.7c0-6.2 3-9.2 7.5-9.2m281.3 0c4.2 0 7.2 3 7.2 9.2v119.7c0 8.4-6 18.3-13 22.6l-111.5 64.4c-7.2 4.1-12.9 0.7-12.9-7.6V335.1c0-8.3 5.7-18.4 12.9-22.5L391 248.1c2.1-1.1 4.2-1.5 5.8-1.6m-185 65.5h-1.1c-5.3 0.4-8.5 4.8-8.5 11.6c-0.6 10.4 7.2 24.1 16.9 29.8c9.8 5.6 17.6 1.1 17.2-9.9c0.2-14.2-13.3-31.1-24.5-31.5m130.9 21.8c-11.2 0.1-24.8 17.2-24.7 31.4c0.1 10.4 7.7 14.4 17.2 8.9c9.4-5.5 17-18.3 17.1-28.8c0-6.7-3.3-11.1-8.5-11.5zm-216.9 22.5c-5.4 0.3-8.7 4.7-8.7 11.6c-0.5 10.5 7.3 24.1 17 29.8c9.8 5.5 17.6 1 17.2-10.1c0-14.5-14.1-31.8-25.5-31.3",
  "dice-twenty-faces-twenty":"M248 20.3L72.3 132.6L248 128.8zm16 0v108.5l175.7 3.8zm51.4 58.9c6.1 3.5 8.2 7.2 15.1 4.2c10.7 0.8 22.3 5.8 27.6 15.7c4.7 4.5 1.5 12.6-5.2 12.6c-9.7 0.1-19.7-6.1-14.6-8.3c4.7-2 14.7 0.9 10-5.5c-3.6-4.5-11-7.8-16.3-5.9c-1.6 6.8-9.4 4-12-0.7c-2.3-5.8-9.1-8.2-15-7.9c-6.1 2.7 1.6 8.8 5.3 9.9c7.9 2.2 0.2 7.5-4.1 5.1c-4.2-2.4-15-9.6-13.5-18.3c5.8-7.4 15.8-4.6 22.7-0.9m-108.5-3.5c5.5 0.5 12.3 3 10.2 9.9c-4.3 7-9.8 13.1-18.1 14.8c-6.5 3.4-14.9 4.4-21.6 1.9c-3.7-2.3-13.5-9.3-14.9-3.4c-2.1 14.8 0.7 13.1-11.1 17.8V92.3c9.9-3.9 21.1-4.5 30.3 1.3c8 4.2 19.4 1.5 24.2-5.7c1.4-6.5-8.1-4.6-12.2-3.4c-2.7-8.2 7.9-7.5 13.2-8.8m35 69.2L55.4 149l71.2 192.9zm28.2 0l115.3 197L456.6 149zm-14.1 7.5L138.9 352.6h234.2zm133.3 21.1c13.9 8.3 21.5 26.2 22.1 43c-1.3 13.6-0.7 19.8-15.2 21.4s-23.9-19.2-29.7-32.6c-3.4-9.9-5.8-24 1.7-31.3c6.1-4.8 15-4.1 21.1-0.5m-223.7 16.1c2.1 4-0.5 11.4-4.8 12.1c-4.9 0.7-3.8-9.3-9.4-11.6c-6.9-2.3-13.6 5.6-15 11.6c10.4-4 20.3 7.1 20.3 17c-0.4 11.7-7.9 24.8-19.7 28.1h-5.6c-12.7-0.7-18.3-15.8-14.2-26.6c4.4-15.8 10.8-33.9 27.2-40.6c8.5-3.9 19 3.2 21.2 10m213.9-8.4c-7.1-0.1-4.4 10-3.3 14.5c3.5 11.5 7.3 26.6 18.9 30c6.8-1.2 4.4-12.8 3.7-16.5c-4.7-10.9-7.1-23.3-19.3-28M52 186v173.2l61.9-5.7zm408 0l-61.9 167.5l61.9 5.7zm-117.9 0.7l28.5 63.5l-10 4.4l-20-43.3c-6.1 3-13 8.9-14.6-1.4c-1.3-3.9 8.5-5.1 8.1-11.9c-0.3-6.9 2.2-12.2 8-11.3m-212 27.4c-2.4 5.1-4.1 10.3-2.7 15.9c1.7 8.8 13.5 6.4 15.6-0.8c2.7-5 3.9-11.7-0.5-15.7c-4.1-3.4-8.9-2.8-12.4 0.6m328.4 41.6c-0.1 18.6 1.1 39.2-9.7 55.3c-0.9 1.2-2.2 1.9-3.7 2.5c-5.8-4.1-3-11.3 1.2-15.5c1 7.3 5.5-2.9 6.6-5.6c1.3-3.2 3.6-17.7-1-10.2c0.7 4-6.8 13.1-9.3 8.1c-5-14.4 0-30.5 7-43.5c5.7-6.2 9.9 4.4 8.9 8.9M59.9 245.5c0.6 0.1 1.3 1 2.5 3.6v61.1c-7.3-7-4.5-18-4.5-26.4c0-8.4 1.6-16.3-1.3-23.2c-4.6-1.7-5.8-17-3.2-12.7c4.4 4.8 4.7-2.7 6.4-2.4m178.8 7.6c8.1 4.5 13.8 14.4 10.8 23.6c-2.1 15.2-27 21.1-30.4 29.7c-1.2 3 25.4 1.6 30.2 1.6c0.5 4 1.5 10.7-3.8 11.7c-14.5-1.2-29.9-0.6-45.1-0.6c0.4-11.2 7.4-21.3 17-26.8c6.9-4.9 15.4-9.3 18.1-17.9c1.8-4.5-0.6-9.3-4.6-11.5c-4.2-2.9-11-2.3-13.2 2.7c-2 3.8-4.4 9.1-8.7 9.6c-2.9 0.4-9 0.5-7.2-4.9c1.4-5.6 3.4-11.5 8.2-15.2c8.8-6.3 19.9-6.7 28.7-2m53.3-1.4c6.8 2.2 12 7.9 14.3 14.6c6.1 14.7 5.5 33.1-4.4 45.9c-4.5 4.8-10.2 9.1-17 9.1c-12.5-0.1-22.4-11.1-24.8-22.8c-3.1-13.4-1.8-28.7 6.9-39.8c6.8-7.6 16-10.3 25-7m156.1 8.1c-1.6 5.9-3.3 13.4-0.7 19.3c5.1-2 5.4-9.6 6.6-14.5c0.9-6.1-3.5-12.6-5.9-4.8m-176.2 21.1c0.6 10.5 1.7 22.8 9.7 28.2c4.9 1.8 9.7-2.2 11.1-6.7c1.9-6.3 2.3-12.9 2.4-19.4c-0.2-7.1-1.5-15-6.7-20.1c-12.2-4.4-15.3 10.9-16.5 18M434 266.8V328l-4.4 6.7v-42.3c-4.6 7.5-9.1 9.1-6.1-0.9c6.1-7.1 4.8-17.4 10.5-24.7M83.8 279c0.8 3.6 5.1 17.8 2 14.8c-2-1.3-3.6-4.9-3.4-6.1c-1.6-3-3-6.1-4.2-9.2c-3 4-4 8.3-3.1 13.4c0.2-1.6 1.2-2.3 3.4-0.7c7.8 12.6 12.2 29.1 7.3 43.5l-2.2 1.1c-10.4-5.8-11.4-19.4-13.4-30c-1.6-12.3-0.8-24.7 2.3-36.7c5.2-3.8 9.2 5.4 11.4 9.9m-7 20.2c-4.1 4.7-2.3 12.8-0.4 18.4c1.1 5.5 6.9 10.2 6.1 1.6c0.7-11.1-2.3-12.7-5.7-20m66.4 69.4L256 491.7l112.8-123.1zm-21.4 0.3l-53.8 4.9l64.2 41.1c-2.6-2.7-4.9-5.7-7.1-8.8c-5.2-6.9-10.5-13.6-18.9-16.6c-8.8-6.5-4.2-5.3 2.9-2.6c-1-1.8-0.7-2.6 0.1-2.6c2.2-0.2 8.4 4.2 9.8 6.3l24.7 31.6l65.1 41.7zm268.4 0l-42.4 46.3c6.4-3.1 11.3-8.5 17-12.4c2.4-1.4 3.7-1.9 4.3-1.9c2.1 0-5.4 7.1-7.7 10.3c-9.4 9.8-16 23-28.6 29.1l18.9-24.5c-2.3 1.3-6 3.2-8.2 4.1l-40.3 44l74.5-47.6c5.4-6.7 1.9-5.6-5.7-0.9l-11.4 6c11.4-13.7 30.8-28.3 40-35.6s15.9-9.8 8.2-1.5l-12.6 16c10-7.6 0.9 3.9-4.5 5.5c-0.7 1-1.4 2-2.2 2.9l54.5-34.9zM236 385.8v43.4h-13.4v-30c-5-1.4-10.4 1.7-15.3-0.3c-3.8-2.9 1-6.8 4.5-5.9c3.3-0.1 7.6 0.2 9.3-3.2c4.4-4.5 9.6-4.4 14.9-4m29 0.5c12.1 1.2 24.2 0.6 36.6 0.6c1.5 3 0.8 7.8-3.3 7.9c-7.7 0.3-21-1.6-25.9 0.6c-8.2 10.5 5.7 3.8 11.4 5.2c7 1.1 15 2.9 19.1 9.2c2.1 3.1 2.7 7.3 0.7 10.7c-5.8 6.8-17 11.5-25.3 10.9c-7.3-0.6-15.6-1.1-20.6-7.1c-6.4-10.6 10.5-6.7 12.2-3.2c6 5.3 20.3 1.9 20.7-4.7c0.6-4.2-2.1-6.3-6.9-7.8s-12.6 1-17.3 1.8s-9.6 0.5-9-4.4c0.8-4.2 2.7-8.1 2.7-12.5c0.1-3 1.7-7 4.9-7.2m133.5 5c-0.2-0.2-7 5.8-9.9 8.1l-15.8 13.1c10.6-6.5 19.3-12 25.7-21.2m-247 14.2c2.4 0 7.5 4.6 9.4 7l26.1 31.1c-7.7-2.1-13.3-7.1-17.6-13.7c-6.5-7.3-11.3-16.6-21.2-19.6c-9-5-5.2-6.4 2.1-2.2c-0.3-1.9 0.2-2.6 1.2-2.6",
  "dna2":"M415 17.6c-4.9 3.6-9.4 7.8-13.5 12.7c-13.1 15.6-20.8 37.5-21.4 66.8c-20.4-12-42.8-16.8-64.6-16c-22.8 0.8-44.9 7.9-63 19.7c-20.7 13.4-36.7 33-42.5 56.6c-4.7 19.1-2.5 40.6 8.4 62.2a260 260 0 0 0-16.9-0.6c-1.6 0-3.3 0-4.9 0.1c-38.6 0.8-68.5 11.4-87.4 31.9c-22.5 24.3-27.1 60.7-14.3 104.4c-25.9-6.3-52.1-5.5-75.9 5.4v40.9c5.8-4.9 13-9.2 21.6-12.7h0l81.2 55.1c0 0.8 0 1.5 0 2.3c0 13.5-3 24.8-8.8 34.4l-94.1-65v22.7l78.9 54.5h29.4c8.7-13.2 13.2-29.1 13.2-46.6c0-18.4-4.6-38.6-13.8-60.4c51.7 16.2 97.8 3.3 123.8-26.3c25.2-28.8 30.1-72.7 5.7-115.9c34.9 5.5 64.6 4.1 88.3-4.3l0.2 0.3l1.1-0.8c8.5-3.2 16.3-7.3 23.1-12.3c25.5-18.8 36.9-50.2 33.1-89.6c28.4 18.7 61.3 21.9 92.3 18.8V81.2l-23.2-63.7H415zm37.2 2.9l36.5 99.9c-8.6 0.8-17.9 0.8-28-0.1l-33.9-88.2c7.3-5.3 15.9-9 25.4-11.7zM412.4 46.8l27.2 70.8c-12.7-2.2-26.3-5.6-40.7-10.2c-1.1-28.2 4.3-47.4 13.4-60.6zm-75.6 69.7c13.4 0.7 28.2 2.7 44.1 6.1c4.4 21.8 4.2 40 0.2 54.8zm-22.9 0.3l58.2 80c-3.9 5.7-8.6 10.6-14.2 14.7c-2.2 1.6-4.6 3.1-7.1 4.5l-66.6-93.3c8.7-3 18.6-5 29.7-5.9zm-46.8 14.1L333 223.2c-9 2.6-19.3 4.1-30.8 4.6L247.1 152c4.3-7.6 10-13.9 17.1-19.1c0.9-0.7 1.9-1.4 2.9-2.1zm-27.7 42.4l39.3 54c-10.8-0.8-22.5-2.5-34.9-5.1l-0.1-0.2l-1.5-0.2c-0.3-0.1-0.6-0.1-0.9-0.2c-0.2-0.3-0.4-0.6-0.6-0.9c-3.6-18.4-3.9-34.2-1.3-47.5zm-38.2 64.4c9 0 18.7 0.6 28.9 1.7c5.6 15.8 8.7 30 9.6 42.6l-46.6-44.1c1.4-0.1 2.8-0.1 4.3-0.2c1.3 0 2.5 0 3.8 0zm-32.3 3l69.5 65.8c-2.3 11.5-7.1 21.1-14.2 28.9l-86.5-83.4c8.6-5 19-8.8 31.2-11.2m-45.9 23l86.6 83.5c-7.9 4.7-17.5 8.4-28.7 10.8l-71-67.2l-1.5 1.6c2.5-11.4 7.4-20.9 14.5-28.7m-16.3 49.8l50.4 47.8c-12.2 0.7-25.9 0.4-40.8-1.3c-6.1-17.4-9.2-32.9-9.6-46.5zm-3.8 65.1c7.2 14.5 12.3 28.1 15.4 40.4l-54.4-36.8c11.5-2.3 24.4-3.5 38.9-3.6zm-83.8 91.6l0 22l1.2 0.8h35.4l-36.7-22.8z",
  "dragon-breath":"M15.3 13v61.3c76.7 54.2 157.8 147.6 64.8 125.6c57.1 55.1 104.1 26.8 174 135.5c30.4 47.3 7.5 80.5-29.8 90.5c-47.9 12.8-114.4-30.4-57.8-54.3c-59.3-1.4-67 48-38.7 80.2c-27.9-9.6-46-34.3-43-60.6c-36 48.3-5.4 93.3 54.3 102.4h357.4v-344.6c-15.8-70.3-94.9-87.8-103.4-3.5c14.6-36.4 51-20.6 84.1 18.7c-11.3-7.5-24.2-11.5-36.2-11.1c-19.7 0.7-37.4 12.1-41.5 36.8c55.9-46.1 84.6 34.7 61.7 76.9c-24.7 45.6-94.9-20.5-95-75.7c-28 31.2-7.8 108.3 52.4 122.5C304.6 301.3 342.7 182.9 295.7 157.8C324.4 285.5 121.7 62.3 66.1 13h-50.8z",
  "dragon-head":"M200.9 18.7c-7 0.1-14.6 0.8-22.9 1.9c27.6 20.5 51.1 45.2 67.6 70.5c1.7 0 3.3 0 5 0c18.1 0.4 35.5 2.9 53.2 7.2c-15.7-28.5-29.9-50.2-47.5-63.2c-13.8-10.3-30.1-16.2-52.5-16.5q-1.4 0-2.9 0zm-91.7 23q-1.1 0-2.2 0c-14 0.3-29.4 3.9-46.9 11.1c56.2 18.8 107 50.5 133.9 83.6c18.4-5.1 29.4-14.7 36.5-28.8C195.8 78.2 168.1 56.2 140.7 47c-10.2-3.4-20.4-5.3-31.4-5.3zm-0.2 52.8c-39.4 6.8-74.7 31.9-87.8 74.2v322.3h212.7C100.4 442.6 61.2 206.5 187.1 230.1c5.8-14.2 9.9-28 11-41.5l18.6 1.5c-1.7 20.6-8.8 40.5-18 59.9c-0.7 2-1.5 4.1-2.2 6.1c32.8 85.2 113.8 160.7 169.5 168.2c0.9 0 1.9 0 3-0.1c17 1 35.9-4.2 52.2-22.3l8-8.8l-10.5-5.7c-6.5-3.5-14.3-7.1-18.2-10.9c-1.9-1.9-2.8-3.5-3.1-5.2c-0.3-1.7-0.1-4.2 2.2-8.6l10.7-19.7l-21.5 6.2c-6.3 1.8-17.3-3-23.2-10.7c-3-3.8-4.4-7.9-4.4-10.8c0-2.9 0.7-5.1 4.7-8.1l19.5-14.1l-23.9-2.7c-10-1.1-16.4-6.7-19.2-12.3c-2.8-5.6-2.3-10.1 1.4-13.3l12.2-10.7l-15.4-5.2c-6.7-2.3-10.3-7.6-10.4-10.6c0-1.4 0.2-2.7 1.8-4.5c10.9-2.4 21.3-0.5 28.1 6.4c6.2 6.1 8.3 15.1 7 24.8c8.6-2.3 17-1.6 24.1 2.5c9.3 5.4 14.6 15.7 15.7 28c15.2-10.1 32.2-12.7 45.3-5.2c15.5 8.9 21.4 29.5 16.8 51.8c24-33.4 34.6-75.7 5.6-120.4c-46.7-4.4-81.7-30.7-93.3-67.6c-5-16-21.3-28.7-42-37.9l-0.1 0.2c-29.7-10.8-55.6-17.4-82.6-18.7l0.1 0.2c-2.3-0.1-4.6-0.2-6.8-0.2c-9.5 22.9-28.7 39.9-57.4 46.1l-5.9 1.3l-3.6-4.9c-14.2-19.3-41.2-40.5-74-58.1zm156.2 65.3c27.9-0.1 44.9 11.6 42.1 44.5c-35.8 3.4-51.9-16.7-63.1-42.6c7.5-1.2 14.5-1.8 21-1.8zm48.4 66.4c3.7 0.1 7.1 1 10 2.8a35 35 0 0 0-4.2 3.5c-5.2 5.2-8.1 12.1-8 18.7c0.2 9.3 5.3 17.2 12.7 22.6c-3.1 8.1-2.5 17.5 1.4 25.2c3.8 7.7 10.5 14.3 19.3 18.4c-1.4 3.4-2.4 6.9-2.4 10.3c-0.1 8.4 3.4 16 8.3 22.4c6.8 8.8 16.9 15.9 28 17.9c-0.2 2.2-0.2 4.3 0.1 6.4c1.1 6.4 4.5 11.7 8.4 15.5c3.4 3.4 7.2 5.9 10.8 8c-6.3 4.8-12.4 7.1-18.6 7.8c-6.5-7.9-9.7-19.1-9.4-31.5c-11.8 6.2-24.2 7.2-34.1 1.4c-14.7-8.5-19.4-29-13.2-50.3c-11.3 2.8-22.1 0.9-29.2-6.1c-8.9-8.9-9.5-23.6-3.1-38c-3.7-0.6-7-2.2-9.5-4.7c-8.8-8.8-5.8-26.1 6.8-38.6c7.8-7.8 17.5-12 25.9-11.8z",
  "evil-tower":"m64 22.7l64 27.6l16-16zm384 0l-80 11.6l16 16zm-204.9 5.9c-17.1 3.2-34.4 12.1-48.1 21.2c-11.7 7.8-19 14.1-23.6 18.3c7.8 12.2 21 25 35.6 34.7c12.3 8.2 25.7 14.2 37.1 16.9l-13.4-53.8zm25.8 0l12.5 37.4l-13.4 53.8c11.4-2.7 24.8-8.7 37.1-16.9c14.6-9.8 27.8-22.5 35.6-34.7c-4.6-4.2-11.9-10.5-23.6-18.3c-13.7-9.2-31-18-48.1-21.2M256 46.8l-6.6 19.9L256 93.2l6.6-26.5zM128 66.3l-96 16l112 16zm256 0l-16 32l112-16zm-224 48l-80 48l96-32zm192 0l-16 16l96 32zm-152.2 29.9l-25.8 297.1h27.6l13.2-289.8c-4.6-2.2-9.5-4.5-14.9-7.2m112.4 0c-5.4 2.7-10.3 5.1-14.9 7.2l13.2 289.8h27.6zm-79.7 14.6L219.6 441.3h72.8l-12.8-282.5c-8.3 2.9-15.9 4.5-23.6 4.5s-15.2-1.6-23.6-4.5zm-85.9 300.5l-50 30H199.4l1.4-30zm72.3 0l-1.4 30h77.2l-1.4-30zm92.5 0l1.4 30h102.9l-50-30z",
  "falling-star":"m166.4 25.6l-12.8 12.7l160 160l12.8-12.8zm-32 96L128 128l-6.4 6.4l160 160l12.8-12.8zm-96.1 32L25.6 166.4l160 160l12.8-12.8zm314.8 86.6l-29.4 84.1l-85.4 26l71 54l-1.7 89.2l73.2-50.8l84.4 29.1l-25.7-85.3l53.8-71.2l-89.1-2z",
  "feathered-wing":"M22.5 28.8c107.6 68.1 207 121.5 322 133.7c40.7 4.3 47.8 34.9 31.7 70.1c-26.5 57.8 16.4 143.5 112.3 195.5c-6 28-46.3 51.5-71.2 43.3c-20.7-43.2-52.9-88.7-87.8-76.4c-71.4 25.3-144.9 30.7-194.8 3.4c66.2-9 129.3-26.6 184.8-54.3C219.2 359 100.4 359.4 55.4 309c91.1 3.6 164.9-5.6 247.3-26.2C192.9 272.7 72.2 252.6 38.3 185.3c81 25.2 189.6 34.6 263 35.2C186.9 191.7 32.9 112.7 22.5 28.8z",
  "fire-ace":"m255.3 17.2l-8.5 22.1C227.7 89.3 185.5 123 146.1 157.2c-39.4 34.1-76.8 69.7-78.5 123.7c-1.8 57 34.2 93.4 76.9 101.8c38.6 7.5 82.8-6.8 110.8-43.8c27.8 40.2 71.3 53.6 109.3 44.2c41.7-10.4 76.9-47.9 78.6-101.5c0.9-28.5-8-52.4-22.1-72.7s-33.1-37.3-53-54.1c-39.9-33.4-83.5-65.6-103.8-115.5l-8.9-21.9zm0.5 47.6C280.5 109.9 321.3 140 356 169c18.6 15.6 35.5 30.9 47.7 47.7c-15.2-15.3-36.6-25.9-62.8-27.8c14.2 7.4 22 20.7 25.6 41.2c-22.9-22.1-45.3-24-70.2-3.3c25.3-5.3 45 23.2 28.1 43.5c-17.2 20.6-51.3 0.5-52.6-28.9c-17.4 10.7-14.5 45.6-41.8 41.7c6.9-31.9-1.7-52.9-30.1-64.7c4.4 7.5 5.5 17.5 3.3 26.8c-4.1 17.3-19.7 28.2-35.1 23.4c-18-5.6-23.7-24.7-18.4-48.5c3.5-15.6 12.7-27.5 24-35.1c-18.3 0.8-34.3 6.8-47.6 16.1c9.7-10 20.6-19.8 32.2-29.8c34.4-29.8 73.9-61.2 97.5-106.5m24.7 108.5c-24.2 0.4-40.2 22.4-32.3 55.2c14.1-38.1 44.2-41.7 81.4-30.4c-17.1-17.6-34.6-25.1-49.1-24.8zM256.8 366.2l-60 119.2h120.1z",
  "fire-gem":"M201.2 32L215 87h82l13.8-55zm-17 5.8L73.2 121.1l53.4 13.3l71.1-42.7zm143.6 0l-13.5 53.9l71.1 42.7l53.4-13.3zM210.4 105L137 149.1v213.8l73.4 44.1h91.2l73.4-44.1V149.1L301.6 105zM64 137.2v237.6l55-13.8V151zm384 0L393 151v210l55 13.8zm-192.1 2.4c-14.6 14.6-21.8 29.1-7.3 50.9c20.2 30.3 95 51.9 94.7 116.5c0 43.6-36.5 65.4-87.4 65.4s-87.3-36.4-87.3-72.7c0-14.5 7.3-29.2 29.1-43.7c-14.6 36.4 0 58.2 21.9 58.2c21.7 0 36.3-21.8 36.3-36.4c0-36.3-43.6-43.6-43.6-87.3c0-23.3 14.5-43.6 43.6-50.9m-129.3 238l-53.4 13.3l111 83.3l13.5-53.9zm258.8 0l-71.1 42.7l13.5 53.9l111-83.3zM215 425l-13.8 55h109.6L297 425z",
  "fist":"m329.8 235.7l62.8-82.7l42.9 32.6l-62.8 82.8zm-12.9-9.5l66.8-88l-45-34.1l-66.8 88zm-27.5-97.8l-19.3 39.6l57-75l-42.5-32.3l-36.2 47.7zm-20.7-73.2l-46.6-35.4l-42 55.3l53.7 26.2zm107 235.5l-139-102.7l-9.9 0.9l4.6 2l62.2 138.4l-16.5 2.2l-57.7-128.5l-40-17.7l-4-30.8l39.4 19.4l36.4-3.3l17-34.8l-110.9-54.1l-80.7 112.5L177.6 346.7l-22.7 145.6H341V372.6l35.3-48.9L387 275.8z",
  "flame":"M245.1 15.5c34.3 48.8-23.5 320.5-90.3 136.7C106.8 325.1 39 332.5 38.9 252.6c-71.6 79.3 43.8 220.8 87.4 243.9h52.1c-45.9-40-76.8-78-82.2-136c47.3 9.4 71.9 21 81.3-62c60.7 86.6 100.9-49.4 137.2-107.1c-1.6 40.3-3.3 93.5 22.8 129.9c8.7 12.1 33.2 16.1 54.7 15.8c-9.9 16.1-44.8 69.4-17 89.2s33.1-0.4 25.9 16.2c-13.3 20.9-23 39.4-59.1 54.1h56.1c59.4-18.7 111.8-91.7 94.6-135.5c-22 18.7-43.8 30.9-61.3 29.5c49.1-72.1 37.8-145.9 14.8-221.3c-20.2 72.4-33.5 82.5-54.6 99.5c29.1-68.7-85.4-214.4-146.5-253.2z",
  "flame-spin":"M363.3 19.6c28.2 48 33.5 103.1 19.3 152.9c-29.3-28-66.8-50.9-105.5-71.8c57.9 75.8 58.1 128.6 53.3 183.4c-24.6-87-113.2-131.9-189.1-102c53.6-2.2 104.1 31.9 118.8 84.8c16.9 60.7-18.7 125-81.2 138.1c-30.2 6.4-58.9 1.1-84.2-12.2c0.2 0 0.4 0 0.6 0c-37.9-20.6-49.1-55.7-34.2-80.6c1.5-3.4 3.6-6.8 6.3-9.8c9.6-10.6 23-12.9 29.8-5c6.9 7.9 4.7 22.8-4.9 33.5c-6.7 7.4-15.3 10.8-22.2 9.4c3.6 9.9 10.3 19.6 20.5 27.8c39.1-11.2 52.3-56.5 33.3-89.8c37.4 27.7 27 83-14.8 101.1c5.8 2.6 12.2 4.8 19.2 6.6c24.3-10.8 44.4-33.7 52.4-63.5c13.3-49.4-11.4-99-55.1-110.9c-28.2-7.7-57.4 2.3-78.2 23.5c-13.6 12.9-23.1 30.1-27 51.5l0.3-0.4c-1.8 8.9-2.4 17.8-1.9 26.3c-4 99 56.2 148.9 159.2 176.9c64.1 17.4 133 1.8 183.8-35.9c97.6-64 151.2-188.1 121.7-305.2a265.5 265.5 0 0 1-21.9 56.8C466 132.1 430.2 59.5 363.3 19.6zm-226.8 83.9c-53.6-0.4-105.3 31.5-116 135.6c14.6-21.1 35.9-36.3 61.1-44.7C88.5 139.8 136.3 107.7 192 114c-17.6-6.3-36.7-10.4-55.5-10.5zm287.1 42.9c43.4 86.7-9.4 222.1-84.9 277.9c-47.3 39.4-120.8 54.7-210.9 21.9C373.6 467.7 416.7 295.7 337 161.1c42.2 43 60.7 93.3 59.9 140.4c21.9-49.2 32.3-104.7 26.8-155.2zm-315.4 81c34.7 0.5 66.7 28.1 55.5 91.8c-0.9-54-72.8-112.3-126.3-29.1c3.4-39.8 38.2-63.2 70.8-62.7zm184.5 41.5c57.2 46.6 14.3 155.7-98.2 152.8c58.1-8.2 124.5-89.3 98.2-152.8z",
  "fluffy-flame":"M92 24.7c-2.9 0-5.9 0.2-8.8 0.5C36.2 30.9 9.1 81 22.5 137.1a131.7 131.7 0 0 0 15.6 37.7c0-0.1 0-0.2 0-0.3a38.5 38.5 0 0 0 4.8 6.4c11.3 12.1 27.8 13.9 36.8 4.7s7.2-26.5-4.1-38.5c-1.4 7.6-7.8 13.4-15.8 13.4c-9 0-16.4-7.4-16.4-16.4c0-1.9 0.3-3.4 0.8-4.9C54 117.5 73.8 100.8 98.9 96.1c30-5.6 59.2 7.6 75.4 31.3c4.6 13.2 6.1 24.8 5.6 35.5c-0.8 19.6-8.4 37.3-17.1 57.2c-12.2 27.7-26 59.8-22.5 104.2c1.3 57.8 31.5 113.7 84.9 145.4c82.4 48.9 188.7 21.7 237.6-60.6c48.9-82.3 21.7-188.7-60.6-237.5a173.6 173.6 0 0 0-40.8-17.6c45 34.6 60.4 96.1 36.7 147.9a104 104 0 0 0-2.4-12.9c-13.9-54.5-69-88.1-123.5-74.2c-8.9 2.3-16.9 6.5-24.5 10.8c35.9-5.1 70.1 16.6 79.3 52.5c9.8 38.5-13.1 77.2-51.7 87a72.6 72.6 0 0 1-29.6 1.3a123 123 0 0 1-21.6-10.1c-14.7-8.7-26.9-20.1-36.4-33.1c-16.8-32.1-20.4-63-8.2-94.4l0 0l0.5-1.2c8.8-20 17.7-40.1 18.7-64c0.4-9.2-0.5-18.9-2.9-29.2c-0.5-5.9-1.5-12-3-18.1c-12.6-52.6-56.5-91.7-100.7-91.7zm282.4 57.5c-28.5-0.4-54.5 19.4-67.2 61.7c30.8-33.3 129-6.4 182.1 96.5C476.7 139.3 422 82.8 374.4 82.2z",
  "flying-target":"M32 26c2 59 24.7 113.9 55.4 152.7c-25-8.5-47.9-18.2-67.3-30.5C38.3 221.2 81.5 252.4 124.8 260.4c-18.4 2.8-41.6 4-71.8 2.8c54.5 34.4 102 41.9 137.1 33C160.4 275.3 141 240.9 141 202c0-25.3 8.2-48.7 22.1-67.7C116.4 116 72.2 75.9 32 26m448 0c-40.2 49.9-84.4 90-131.1 108.3C362.8 153.3 371 176.7 371 202c0 38.9-19.4 73.3-49.1 94.2c35.1 8.9 82.6 1.4 137.1-33c-30.2 1.2-53.5 0-71.8-2.8c43.3-8 86.5-39.2 104.7-112.2c-19.4 12.3-42.3 22-67.3 30.5C455.3 139.9 478 85 480 26m-224 79c-53.7 0-97 43.3-97 97c0 53.3 42.8 96.5 96 97L208 346v16h28.8L224 490h64l-12.8-128H304v-16l-47-47C310.2 298.5 353 255.3 353 202c0-53.7-43.3-97-97-97m0 17.3c43.9 0 79.7 35.8 79.7 79.7S299.9 281.7 256 281.7S176.3 245.9 176.3 202s35.8-79.7 79.7-79.7m0 18c-34.2 0-61.7 27.5-61.7 61.7s27.5 61.7 61.7 61.7s61.7-27.5 61.7-61.7s-27.5-61.7-61.7-61.7m0 17.3c24.4 0 44.3 20 44.3 44.3S280.4 246.3 256 246.3S211.7 226.4 211.7 202s20-44.3 44.3-44.3m0 18c-14.7 0-26.3 11.7-26.3 26.3s11.7 26.3 26.3 26.3s26.3-11.7 26.3-26.3s-11.7-26.3-26.3-26.3",
  "focused-lightning":"M19.6 18.1V104.5l210.1 181.8l-85 178.2l230.9-92.2l-39.9 117l94.5-35.8l67.6 44.5l-34.6-106.3l-59.8 27.5l76.8-168.2l-198 99.1l76.5-122.8L238.2 18.1H121.8L312.4 244.7L218.5 393.8l58.3-142.8L43.7 18.1H19.6z",
  "gears":"M179.6 22.3L163.2 58.9a88 88 0 0 0-9.7-0.6c-10.6-0.1-20.9 1.8-30.5 5.3L99.8 31L55.8 63.2l24.1 33.7a88 88 0 0 0-14.5 35.8l-42.7 4.7l5.3 54.2l45.5-5A89.9 89.9 0 0 0 94 213.5l-19.4 43.4l49.4 22.1l19.5-43.6c11.7 1.2 23.1 0.1 33.8-3l28.1 38.5l31.7-23.2l11.7 20.2A209 209 0 0 0 209.6 307l-49.2-28.3l-25.7 46.7l48.1 27.9a206.7 206.7 0 0 0-14.3 53.8H112.5v53.7h56.2a204.4 204.4 0 0 0 8 35.1h169.3c-23.9-10.8-40.6-34.8-40.6-62.7c0-38 30.8-68.8 68.7-68.8c38 0 68.8 30.8 68.8 68.8c0 27.9-16.7 52-40.6 62.7h91.5V200.4l-11.7-6.4L454.6 242A204.3 204.3 0 0 0 401 227.3v-55.5h-53.7v55.5c-18.3 2.4-35.8 7.2-52.3 14l-27.1-47.3l-36 20.2l-9.2-13a88.7 88.7 0 0 0 15.5-31.7l44.4-4.8l-5.3-54.2l-42.2 4.2A89 89 0 0 0 212.4 81.5L229 44.4zm-27.3 84.2c23.3-0.2 42.9 17.8 44.4 41.3c1.5 24.3-17 45.1-41.3 46.6c-24.3 1.5-45.1-17-46.6-41.2c-1.5-24.3 17-45.1 41.2-46.6c0.8 0 1.5-0.1 2.3-0.1",
  "gems":"m303.2 19.3l-162 93.5l93.5 162l162-93.5l-4.7-8.1l-4.9-8.4l-4.1-7.5l-0.2 0.1zm-20.6 33.5l-50.3 90.1c-19.2-7.7-37.9-17.3-56.2-28.7zm19.9 2.7l63.2 109.5c-40.6 2.1-79-3.3-115.7-15.5l52.4-94zm-251.6 25.7L23 168l74.3 51.1l27.9-86.8l-5.7-3.9l-68.6-47.2zm10.1 29.6l32.3 22.2l-44.2 15zm385.8 22.3l-46.1 17.4l9.1 16.6l20.2-7.6l3 43.5l-39.9 15.1l-0.9-12.7l-18 10.4l2 28.7l76.5-28.9l-5.7-82.4zm-270.6 3c31.9 18.6 65.3 32.1 100.3 40l-39.5 65.2L176.3 136.2zm-76.6 14.4l-12.5 38.9l-33.7-23.2zm196.4 29.3c19 3.1 38.5 4.5 58.4 4.2l-93.7 54.1l35.3-58.2zM21.2 224.7l2 14.3l21.7 158.5l167 49.5l-2-14.6l-23.5-12.5L80 388.5l59.6-26.1l34.4-54.5l6.9 50.8l16.1-20.3l-8.8-64.1zm22.4 26.1l121.5 36l-38.3 60.7l-66 28.9l-17.2-125.7zm313.1 5.2l-88.9 23.8l-1.9 2.4l-89.3 111.6l197.4 103l118.7-187.7l-135.9-53.1zm-13.6 23l31.3 55.3l-86.1 22.7l2.5-64zm21.6 0.2l88.2 34.5l-59.8 15.7zm-93 25.7l-2.2 57l-55 14.5zm184.3 27.2l-73.5 116.3l13.9-100.6zm-79.2 20.9L362.8 454.1l-67.3-79.6l81.3-21.4zM275.4 379.8l67.5 79.8l-124.3-64.9l56.8-15z",
  "grim-reaper":"M246.5 21c-62.3 0.3-123.5 15.7-165 39.4l-6.2 2.1c19.5 58.3 48.2 98.7 80.9 132.4l-1.7 67.5l64.5 30.4c-19 59-34.5 128.9-50.4 197.7h191.1c-10.3-47.1-20.5-94.5-32.2-138.7c23.8 28.1 46.5 61.6 67.1 104.3l16.8-8.1c-22.6-46.9-47.9-83.3-74.3-113.6l31.1-24.3l-47.5-104.4l48.2-33.8c-19-35.5-37.4-71.3-72.3-92.7c-32.5 20-52 56.7-72.2 92.5l-29.2 34.7c-28.9-25.7-55-53.3-76.1-90.5C192.2 60.4 315.9 47.2 419.7 72.6C373.4 35.6 309.4 20.7 246.5 21z",
  "hand-of-god":"M387.3 19.1c-0.7 24.3-8.2 49.3-22.2 71.8c-36.9 59.3-110.6 86.1-178.9 70.6c4.2-2 8.3-4.1 12.1-6.3c39.1-22.5 57.3-55.5 54.3-91.7c-7.4 21.8-24.6 41.3-50.2 56.1c-48 27.7-118 31.7-187.5 16.9v37.4c36.3 13.2 81.9 13 122.4 4a149 149 0 0 0 10 5.9c76.5 41 174.2 17.5 220.2-51.9c40.4 14.7 84.8 19.9 127.3 16.4v-39.1c-36.9 3.6-75.2 0.8-111.4-9c9.5-26.7 10.5-54.7 3.9-81.1zm30.3 160c-28.5 12.3-59.2 14.1-87.4 10.4c-19.3 10.7-41.5 18.6-64.7 23.4c-44.1 9.1-91.9 6.7-129.4-14l78.5 175.9c11.3 12.3 24 25.5 42 41.3l0.2 0.1l0.2 0.2c1.6 1.6 2.7 1.8 5.1 1.6c2.4-0.3 6-1.7 9.3-4s6.5-5.5 8.6-8.5a19.5 19.5 0 0 0 2.3-4.4l-39.7-38.3l13-13.4l45.6 44l0 0c0.2 0.2 0.1 0.4 2.2 0c2.2-0.4 5.7-2 9.3-4.6c6-4.3 11.8-11.4 14.2-16.3l-39.2-37.8l13-13.4l45.1 43.5c11.7-2.6 21.1-10.8 25.2-20.3l-50-48.3l13-13.4l105.8 102.1c5.1 4.9 9.4 6.1 13.1 6s7.2-1.8 9.8-4.6c5.2-5.6 7.5-13.9-2-23.1l-146.7-141.6l13-13.4l23.2 22.4c25.8-2.7 47.5-9.9 61-18.3c7.1-4.5 11.8-9.3 13.9-13.2c2.1-3.9 2.3-6.5 0.8-10.1c-1.1-2.6-3.8-6-8.4-9.6z",
  "heavy-lightning":"M20.5 14.6v112.7l44.4 28l-45 78.3l96.9 49.1l-9.3 32.7l78.8 35l-32.1 96.9l174.6 46.1l-112.7-69.5l22.8-50.2l257.6 113.9l-282.1-203.8l29.2-90.5l47.9 52.6l83.5-40.9l-44.4 87l164.7 108.6l-106.3-126.1l22.8-40.3l74.8 56.6l-84.7-151.3l-71.8 27.4L227.3 14.6H20.5zm77.1 161.2l42.6 26.9l-14.6 50.8l-52.6-34.5l24.5-43.2z",
  "hourglass":"M92.7 19.2v41.5h331.7v-41.5zM119.5 79.4V433.5h22.3V79.4H119.5zm46.6 0c3.2 43.3 13.3 82 27.8 110.9c17.7 35.3 40.8 54.8 64.1 54.8s46.3-19.4 64-54.8c14.5-28.9 24.6-67.6 27.8-110.9H166.1zm209.2 0V433.5h22.3V79.4h-22.3zm-117.3 185.2c-23.2 0-46.4 19.4-64.1 54.7c-14.8 29.6-25.1 69.6-28 114.2H350c-2.9-44.7-13.2-84.6-28-114.2c-17.7-35.3-40.8-54.7-64-54.7zM92.7 452.2v41.5h331.7V452.2H92.7z",
  "imperial-crown":"M256 38.5c-30.5 0-55 24.5-55 55c0 30.4 24.5 55 55 55s55-24.5 55-55c0-30.5-24.5-55-55-55M191.3 164.4c-5.7 0-11.1 0.4-16 1.4c-19.9 4-34.1 15.6-43.1 35.4c-9.4 20.6-12.1 50.6-5.8 88l6 5.9c13.8 13.8 36.1 21.4 58.6 21.4c21.1 0 42.1-6.7 56-19V179.2c-21-9.8-39.8-14.5-55.7-14.8m129.4 0c-15.9 0.3-34.7 5-55.7 14.8v118.3c13.9 12.3 34.9 19 56 19c22.5 0 44.8-7.6 58.6-21.4l6-5.9c6.3-37.4 3.6-67.4-5.8-88c-9-19.8-23.2-31.4-43.1-35.4c-4.9-1-10.3-1.4-16-1.4m-209.1 14.4h-0.2c-30 0.7-55.2 12.1-70.2 32.1c-13.3 17.8-19.5 42.9-13.6 76c0.9 5.1 2.1 10.5 3.7 16c24.5 18.5 54.3 18.6 78.9 0.3c-9.2-44.8-6.9-81.9 5.6-109.4q3.6-8 8.4-14.7c-2.9-0.2-5.8-0.3-8.6-0.3h-3.9c-0.1 0-0.1-0.1-0.1 0m288.8 0c0-0.1 0 0-0.1 0h-3.9c-2.8 0-5.7 0.1-8.6 0.3q4.8 6.8 8.4 14.7c12.5 27.5 14.8 64.6 5.6 109.4c24.5 18.3 54.4 18.2 78.9-0.3c1.5-5.5 2.8-10.9 3.7-16c5.9-33.1-0.3-58.2-13.6-76c-15-20-40.2-31.4-70.2-32.1zM132.8 318.4c6.9 26.1 17.7 54.9 32.9 86.1h58.6l22.7-56.7v-28c-16.4 10-36.3 14.7-56 14.7c-20.7 0-41.5-5.2-58.2-16.1m246.4 0c-16.7 10.9-37.5 16.1-58.2 16.1c-19.7 0-39.6-4.7-56-14.7v28l22.7 56.7h58.6c15.2-31.2 26-60 32.9-86.1m-264.6 3.4c-23 13.9-50.1 16.1-74.5 6.4c9.6 23 24.1 48.5 44.5 76.3h61c-14-29.6-24.2-57.2-31-82.7m282.8 0c-6.8 25.5-17 53.1-31 82.7h61c20.4-27.8 34.9-53.3 44.5-76.3c-24.3 9.7-51.5 7.5-74.5-6.4M256 373.7l-22.1 55.4l22.1 44.3l22.1-44.3zM91.5 422.5l11.5 46h35.3l-23-23l23-23zm90.3 0l16.6 16.6l6.3 6.4l-23 23h51.7l-19.3-38.6l3-7.4zm113.1 0l1.5 3.7l1.5 3.7l-19.3 38.6h51.7l-23-23l23-23zm78.9 0l16.6 16.6l6.3 6.4l-23 23H409l11.5-46zM160 426.2l-19.3 19.3l19.3 19.3l19.3-19.3zm192 0l-19.3 19.3l19.3 19.3l19.3-19.3z",
  "jewel-crown":"M256 77.5c-28.6 59.9-54.6 129.7-55.9 171.2c8.1 8.9 15.5 20.2 21.3 31.8c6.5 13 11.2 25.5 11.2 36.7v7.2l-6.9 1.7c-66.3 16.6-117.5 16.7-168.2-0.2l-6.3-2.1v-6.6c0-15.2-1.4-46.5 15.2-67.4a31 31 0 0 0-4.4-6.2c-4.2-4.6-10.4-9.9-17.1-14.7c-6.7-4.8-14-9.2-20.3-12.2c-1.3-0.6-2.3-0.9-3.5-1.4c0.9 26.7 4.7 70.8 11.7 112.6c2.8 16.6 6 32.7 9.7 46.9c151.6 14.5 275.6 14.5 427.2 0c3.7-14.2 6.9-30.3 9.7-46.9c7-41.8 10.7-86 11.7-112.6c-1.2 0.5-2.2 0.8-3.5 1.4c-6.3 3-13.6 7.4-20.3 12.2c-6.7 4.8-12.9 10.1-17.1 14.7a31.7 31.7 0 0 0-4.3 6.1c17.4 21 15.1 52.7 15.1 67.5v6.6l-6.3 2.1c-50.7 16.9-101.9 16.8-168.2 0.2l-6.9-1.7v-7.2c0-11.2 4.7-23.8 11.2-36.7c5.8-11.6 13.2-22.9 21.3-31.8c-1.3-41.5-27.4-111.3-55.9-171.2zm0 32l42.5 127.6L256 300.9l-42.5-63.8l34-102zm0 56.9l-22.7 68l7.6 11.4c5.1-24.4 12.4-47.6 22.9-55.9zM47.9 393.5c5.5 16.2 12.6 26.7 15.9 29.1c128.2 15.8 256.3 15.8 384.5 0c3.3-2.4 10.4-12.9 15.9-29.1c-146.9 13.6-269.4 13.6-416.3 0",
  "keyboard":"M247 21.1c0 10.5 7.2 18.2 14.7 23.4c7.5 5.2 16.4 9.2 24.7 13.2c8.3 4 16 7.9 20.3 11.7s5.2 5.2 4.5 8.8c-0.5 2.3-1.2 3.3-2.6 4.5c-1.4 1.1-3.8 2.3-7.2 3.1c-6.8 1.6-17.1 1.8-27.9 1.7c-10.9-0.1-22.3-0.3-32.8 2s-21.3 8.2-25.3 19.7c-2.6 7.5-0.2 15.3 3.4 20.8s8.3 9.7 12.9 13.7c3 2.6 5.9 5.1 8.4 7.4h22.9c-1.6-3.4-3.9-6.2-6.2-8.8c-4.1-4.5-8.9-8.4-13.2-12.2c-4.2-3.7-7.9-7.4-9.7-10.1c-1.8-2.7-1.9-3.5-1.4-5c1.5-4.4 4.6-6.3 12-7.9c7.4-1.6 18-1.6 28.9-1.6c10.9 0.1 22.1 0.2 32.3-2.2c5.1-1.2 10.1-3.2 14.3-6.7s7.5-8.7 8.8-14.6c2.3-10.6-3.4-20.3-10.4-26.3c-7.1-6-15.8-10.2-24.2-14.2c-8.5-4-16.7-7.9-22.2-11.7s-7-6.3-7-8.6h-18zM41 169v174h430V169zm7 14h16v18H48zm32 0h16v18H80zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm48 0h48v18h-48zm96 0h32v18h-32zM48 215h32v18H48zm48 0h16v18H96zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h32v18h-32zm48 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm-127.9 25h18v57h-25v-18h7zM48 247h16v18H48zm32 0h16v18H80zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm96 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm-96 16h16v18h-16zM48 279h32v18H48zm48 0h16v18H96zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm112 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zM48 311h16v18H48zm32 0h16v18H80zm32 0h144v18H112zm160 0h16v18h-16zm32 0h16v18h-16zm32 0h16v18h-16zm32 0h48v18h-48zm64 0h16v18h-16z",
  "laurel-crown":"M134.6 73.4c-17.5 5.7-31.2 11.9-48.1 24.2a221 221 0 0 0-6.4 6.4c0.2 0.6 0.6 1.3 1.2 2.2c1 1.8 2.8 4 5 6.2a252 252 0 0 0-9.5 16.6c-3.7-3-7-6.4-9.6-10.2a216.5 216.5 0 0 0-20.4 30.4c0.4 1.6 1.6 3.4 3.8 5.8c2.7 2.9 6.8 5.8 11.6 8.3c-2 6.1-3.8 12.2-5.2 18.3c-7.4-3.4-14.2-7.8-19.6-13.3a211.6 211.6 0 0 0-13.4 43.7c1.3 2.4 3.7 4.7 7.3 7c5.1 3.3 12.4 6.1 20.3 7.7c0 6.4 0.2 12.8 0.8 19.1c-11.4-1.7-22.4-5.2-31.4-11.2c-0.1 0-0.1-0.1-0.2-0.1a214.3 214.3 0 0 0 1.1 45.9c2.3 3.5 6.2 6 11.9 7.9c7.4 2.5 17.5 3.3 27.7 2.3c2 6.1 4.3 12.1 6.8 18c-14 2.1-28.2 1.6-40.6-2.6c-0.3-0.1-0.7-0.3-1-0.4a214.7 214.7 0 0 0 16.8 44.4c3.6 2.8 8.3 4.2 14.7 4.7c9.3 0.6 21.1-1.7 32.4-6.3a231 231 0 0 0 11.8 15.2c-14.6 6.7-30.4 10.7-45.1 9.8a217.3 217.3 0 0 0 34.8 39.8c4.3 1.4 9.3 1.5 15.4 0.3c9.6-1.9 20.9-7.4 31-15c0 0 0 0 0 0a230 230 0 0 0 15.9 11.2c-12 9.9-25.6 17.7-39.5 21.2a214 214 0 0 0 37.3 20.2c4.9 0.4 10.3-1 16.3-3.9c7.7-3.7 15.8-10.3 23-18.3c17 6.8 34.7 11.2 52.6 12.9l1.8-18.6c-14.3-1.4-28.6-4.8-42.6-9.9c6.9-11.1 11.6-23.2 12.9-33.4c1.2-9.1 0.1-16.2-3.8-21.4c-8.1-1.6-15.9-3.9-23.4-7c-0.2 6.5-1.7 13-4.2 19.1c-3.7 9.1-9.5 17.8-16.5 25.7a212 212 0 0 1-15.7-10.6c6.6-7.2 11.9-15 14.9-22.2c3.8-9.2 4.2-16.6 0.6-22.8c-7.7-5-15-10.7-21.7-17.2c-1.8 4.3-4.2 8.4-7 12.1c-5.5 7.2-12.6 13.5-20.6 18.9c-4.1-4.7-8.1-9.6-11.8-14.7c7.2-4.7 13.3-10.1 17.5-15.6c5-6.6 7.2-12.4 6.5-18.1a162 162 0 0 1-13.5-21a50 50 0 0 1-7.7 7.3c-6.8 5.2-14.8 9.2-23.4 12c-2.6-5.7-5-11.5-7-17.4c7.4-2.4 14.1-5.7 19-9.4c5.7-4.4 8.8-8.5 9.5-13.2a180 180 0 0 1-7.4-24.9a45 45 0 0 1-5.8 2.8c-7.5 2.9-15.8 4.4-24.3 4.8a177 177 0 0 1-1-18.7c7-0.3 13.5-1.4 18.4-3.4c4.6-1.8 7.6-3.8 9.3-6.2a192 192 0 0 1-0.8-29.8c-0.7 0.1-1.3 0.2-1.9 0.2c-6.6 0.7-13.6 0.1-20.4-1.3c1.4-6 3.1-12 5.1-18.1c4.9 0.9 9.5 1.2 13.3 0.8c2.6-0.3 4.5-0.8 6-1.4a189 189 0 0 1 6-26c-4.2-0.7-8.3-2.1-12.2-3.9a239 239 0 0 1 9.3-16.4c2.4 1 4.7 1.7 6.7 2c1.1 0.2 2 0.3 2.8 0.3c1.9-4.6 4-9.2 6.3-13.6c5.9-11.8 12.4-24.2 17-37.9zm244.4 0c4.6 13.7 11.1 26.1 17 37.9a191 191 0 0 1 6.3 13.6c0.8 0 1.7-0.1 2.8-0.3c2-0.3 4.3-1 6.7-2a239 239 0 0 1 9.3 16.4c-4 1.8-8.1 3.1-12.3 3.9c2.6 8.4 4.6 17.1 6 26c1.5 0.7 3.4 1.1 6 1.4c3.7 0.4 8.4 0.1 13.3-0.8a193 193 0 0 1 5.1 18.1c-6.8 1.5-13.8 2-20.4 1.3a41 41 0 0 1-2-0.2a192 192 0 0 1-0.8 29.8c1.8 2.5 4.7 4.4 9.3 6.2c5 2 11.5 3.1 18.4 3.4a177 177 0 0 1-1 18.7c-8.5-0.3-16.8-1.8-24.2-4.8a46 46 0 0 1-5.8-2.8a180 180 0 0 1-7.4 24.9c0.7 4.7 3.8 8.9 9.5 13.3c4.9 3.8 11.6 7 19 9.4c-2 5.9-4.4 11.7-7 17.4c-8.6-2.9-16.6-6.9-23.4-12a50 50 0 0 1-7.7-7.3c-4 7.4-8.5 14.4-13.5 21c-0.8 5.7 1.4 11.5 6.5 18.1c4.2 5.5 10.3 10.9 17.5 15.6c-3.7 5.1-7.6 10-11.8 14.7c-8-5.4-15.1-11.7-20.6-18.9c-2.8-3.7-5.2-7.8-7-12.1c-6.7 6.5-14 12.2-21.7 17.2c-3.5 6.2-3.2 13.6 0.6 22.8c3 7.2 8.3 15 14.9 22.2a212 212 0 0 1-15.7 10.6c-7-7.9-12.8-16.6-16.5-25.7c-2.5-6.1-4-12.6-4.2-19.1a125.4 125.4 0 0 1-23.4 7c-3.9 5.3-5 12.3-3.8 21.4c1.3 10.3 6.1 22.3 13 33.4c-14 5.2-28.3 8.6-42.6 9.9l1.8 18.6c17.8-1.7 35.5-6.1 52.6-12.9c7.2 8 15.4 14.5 23 18.3c6.1 2.9 11.4 4.3 16.3 3.9a214 214 0 0 0 37.3-20.2c-13.9-3.5-27.6-11.3-39.5-21.2c5.4-3.5 10.7-7.3 15.9-11.3c10.2 7.6 21.5 13.1 31.1 15c6.1 1.2 11.1 1.2 15.3-0.2a217.4 217.4 0 0 0 34.9-39.8c-14.7 0.9-30.5-3-45.1-9.8c4.1-4.9 8.1-10 11.8-15.2c11.3 4.6 23.1 7 32.4 6.3c6.4-0.4 11.2-1.9 14.7-4.7a214.7 214.7 0 0 0 16.8-44.4c-0.3 0.1-0.7 0.3-1 0.4c-12.4 4.2-26.6 4.7-40.6 2.6a209 209 0 0 0 6.8-18c10.2 1 20.3 0.2 27.7-2.3c5.8-2 9.7-4.5 12-7.9a214.4 214.4 0 0 0 1.1-45.9c0 0-0.1 0.1-0.1 0.1c-9 5.9-20 9.5-31.4 11.2c0.6-6.3 0.9-12.7 0.8-19.1c7.9-1.6 15.2-4.3 20.3-7.7c3.6-2.4 5.9-4.6 7.3-7a211.8 211.8 0 0 0-13.4-43.7c-5.3 5.6-12.1 10-19.6 13.3a213 213 0 0 0-5.2-18.3c4.8-2.5 8.9-5.5 11.6-8.3c2.2-2.4 3.4-4.2 3.8-5.8a216.5 216.5 0 0 0-20.4-30.5c-2.6 3.8-5.9 7.2-9.6 10.2a253 253 0 0 0-9.5-16.6c2.2-2.2 4-4.4 5-6.2c0.5-1 0.9-1.7 1.2-2.2a222 222 0 0 0-6.5-6.4c-16.9-12.4-30.6-18.6-48.1-24.2zM152.8 134.3l24.1 129.7H341l22.9-124.5l-57.9 63.5L261 135.8l-45 67.2l-63.2-68.7zm27.6 148.4l3.6 19.2H334l3.5-19.2H180.4z",
  "laurels":"M234.7 18.1c-21 0.2-38.8 2.5-62 10.2c-4.1 2-8.2 4.1-12.2 6.2c0.8 5.3 3.2 10.8 5.5 14.7c-4.9 4.2-9.6 8.4-14.1 12.8c-3.7-5.5-6.6-11.4-8.3-17.4c-14.2 9.2-27.7 19.6-40.1 31.4c1.9 9.5 9.2 18.2 15.2 24.1c-3.7 5.2-7.2 10.4-10.5 15.7c-8.2-7.2-15.1-15.5-19.3-24.6C75 108.1 61.9 126 53.1 142.3c5.3 13 19 22.7 29.8 28.4c-2 6.1-3.7 12.2-5.1 18.4c-13.5-6.4-26.3-15.7-34.5-26.6c-8.7 20.1-14.7 40.7-18.2 61.4c9.6 15.5 30.6 22.9 46 25.9q0.1 9.6 0.9 19.2c-17.8-2.7-37.3-9.6-49.9-20.4c-1.6 22.3-0.5 44.5 3.4 66.2c15.2 13.7 41.1 15.3 58.6 13.7c2 6.1 4.1 12.2 6.5 18.1c-18.6 4.5-43.3 1.1-59.3-6.2c6.6 23.7 16.4 46.4 29.2 67.4c19.3 8.6 44.5 3.6 61.7-2.5c3.7 5.3 7.6 10.5 11.6 15.5c-17.8 9.5-39.9 11.5-57.5 10.1c12.3 16.3 26.6 31.2 42.7 44.4c4.9 1.1 10.5 1.1 16.7 0.3c11.7-1.7 25.2-7 37.9-14.7c16.7 13.5 34.9 24.7 54.1 33.1l7.5-17.2c-16-6.9-31.3-16.2-45.6-27.3c13.3-10.9 24.3-24 30.2-36.5c4.7-9.7 6.3-18.4 4.5-26.3c-10.7-5.7-20.6-12.5-29.5-20.3c-7.8 20.8-26.4 36.1-43.5 46c-4-4.9-7.9-9.9-11.6-15c16.8-9.8 39.9-27.5 39.1-47.1c-8.9-10.3-16.6-21.8-22.9-34.1c-12 14-30.7 22.5-46.5 26.7c-2.4-5.8-4.6-11.6-6.6-17.6c16.8-5.2 37.9-13 44.1-29.7c-4.3-11.5-7.5-23.6-9.7-36c-13.8 8.4-32 11.1-46.3 10.9c-0.6-6.2-1-12.4-1.2-18.7c15.5-0.6 33.9-2.5 44.9-14.3c-0.8-12.6-0.5-25.5 0.9-38.5c-13.4 2.8-29 0.3-40.4-3.2c1.3-6 2.9-12.1 4.8-18.1c12.8 3.2 27.1 6.7 38.8 0.8c2.7-13.6 6.7-27.3 12-40.8c-9.9-1.8-20.2-6.3-27.7-10.7c3.3-5.3 6.8-10.5 10.5-15.7c8.1 4.2 16.3 8.8 25.2 8.4c5.7-11.6 12.3-22.6 19.5-32.8c-5.1-2.7-10-6.4-14.4-10.6c4.4-4.3 9.1-8.5 13.9-12.7c3.8 3.5 8 6.2 12.3 8.2c15.9-18.6 35.9-36.2 49-53.8zm38.4 0c15.4 20.8 33.8 35.6 48.9 53.7c4.6-1.8 9.1-5.2 12.3-8.1c4.9 4.2 9.5 8.4 13.9 12.7c-4.4 4.2-9.2 7.9-14.4 10.6c7.3 10.1 13.9 21.1 19.6 32.6c9-0.1 18.4-4.4 25.2-8.4c3.7 5.2 7.2 10.4 10.4 15.7c-8.8 5.9-18.2 9.6-27.6 10.7c5.3 13.5 9.3 27.2 12 40.8c12.3 5.4 27.3 2.7 38.7-0.8c1.9 6 3.5 12.1 4.9 18.1c-14.2 3.4-27.3 6.2-40.4 3.3c1.4 12.9 1.6 25.8 0.8 38.5c11.4 12.3 30.2 14.4 44.9 14.2c-0.2 6.3-0.5 12.5-1.2 18.7c-17.1-0.5-32.8-2.5-46.3-10.9c-2.1 12.4-5.3 24.5-9.6 36.1c8.2 17.4 27.8 25.3 44.1 29.6c-2 6-4.2 11.8-6.6 17.6c-18.5-5.6-34.9-13-46.6-26.7c-6.3 12.4-13.9 23.8-22.9 34.1c1.5 22.4 22.4 37.8 39.2 47.1c-3.7 5.1-7.6 10.1-11.6 15c-19-11.8-36.6-25.8-43.5-46c-9 7.8-18.8 14.6-29.6 20.3c-1.8 7.9-0.1 16.6 4.5 26.3c6 12.5 17 25.6 30.3 36.5c-14.3 11.1-29.6 20.4-45.6 27.3l7.4 17.2c19.3-8.4 37.4-19.6 54.1-33.2c12.7 7.8 26.2 13.1 38 14.8c6.2 0.8 11.8 0.8 16.7-0.3c16.1-13.2 30.4-28.1 42.7-44.4c-18 1.7-37.9-2.3-56.5-9.7c-0.3-0.1-0.7-0.3-1.1-0.4c4.1-5 7.9-10.2 11.7-15.5c18.2 7.8 43.7 11.7 61.6 2.5c12.8-21 22.6-43.7 29.2-67.4c-0.4 0.2-0.8 0.4-1.2 0.5c-20.5 6.4-40.1 7.6-58.1 5.7c2.4-5.9 4.5-12 6.5-18c19.1 1.7 45.2 0.1 58.6-13.8c3.9-21.7 5.1-43.9 3.4-66.2c-14.4 10.7-34.9 17.9-49.9 20.4c0.5-6.4 0.9-12.8 1-19.2c16.8-4.8 37.9-10 45.9-25.9c-3.5-20.7-9.5-41.3-18.2-61.4c-9.4 11.6-23.1 21-34.4 26.5c-1.5-6.1-3.2-12.2-5.2-18.3c12-7.4 25.1-15.3 29.9-28.4c-10.1-18.7-22.2-35.8-35.9-51c-4.2 9.1-11.1 17.4-19.2 24.6c-3.3-5.3-6.8-10.5-10.6-15.7c6.2-7.2 14.2-14.7 15.2-24.1c-12.4-11.8-25.8-22.2-40-31.4c-1.8 6-4.7 11.9-8.3 17.4c-4.5-4.4-9.2-8.6-14.1-12.8c2.7-4.8 4.7-9.6 5.4-14.7c-4-2.1-8.1-4.2-12.2-6.2c-24.7-8.2-43.3-10.3-66.2-10.2",
  "laurels-trophy":"M137.3 41c1.4 59.5 16.4 119 35.1 167.8c19.7 51.2 44.1 91 58 104.9l2.6 2.6V343h46v-26.7l2.6-2.6c13.9-13.9 38.3-53.7 58-104.9c18.7-48.7 33.7-108.2 35.1-167.8zm-50.6 68.3c-18 6-32.3 18.2-37.6 30.4c-3 6.9-3.5 13.4-1 20.1c0.3 0.8 0.6 1.5 1 2.3a119 119 0 0 1 8.5-4.8l6.3-3.2l4.6 5.3c5.1 5.9 9.6 12.4 13.4 19.1c2.6-3.1 5.2-7.9 7-14c4.5-15 4.3-37-2.3-55.2m338.7 0c-6.6 18.2-6.7 40.2-2.3 55.2c1.8 6.2 4.5 11 7.1 14c3.8-6.8 8.3-13.2 13.4-19.1l4.6-5.3l6.3 3.2a119 119 0 0 1 8.5 4.8c0.4-0.8 0.7-1.6 1-2.3c2.5-6.7 2-13.3-1-20.1c-5.3-12.2-19.7-24.3-37.6-30.4m-366 67.7c-20.3 12.5-34.1 31.5-36.7 48c-1.4 9.1 0.1 17.2 5.3 24.5c1.7 2.3 3.7 4.6 6.3 6.8a116.6 116.6 0 0 1 11.4-15l4.7-5.2l6.2 3.3c7.9 4.2 15.3 9.4 21.9 15.3c1-3.6 1.6-7.9 1.8-12.6c0.6-19.4-6.8-45.5-21-65zm393.3 0c-14.2 19.5-21.6 45.6-21 65c0.2 4.7 0.8 9 1.8 12.6c6.7-5.8 14-11 21.9-15.3l6.2-3.3l4.7 5.2a116.6 116.6 0 0 1 11.4 15c2.6-2.2 4.6-4.4 6.3-6.8c5.2-7.3 6.8-15.4 5.3-24.5c-2.6-16.5-16.5-35.5-36.7-48M54.4 259.1c-14.4 18.8-20.5 41.4-17 57.7c1.9 9 6.3 16.1 13.8 21.1c4.9 3.3 11.5 5.7 19.9 6.6a120.6 120.6 0 0 1 7.1-17.9l3.1-6.3l6.9 1.5c4.1 0.9 8.1 2 12.1 3.4c-0.4-3.8-1.3-8.2-2.9-12.8c-6.4-18.4-22.7-40.2-43.1-53.4m403.2 0c-20.3 13.2-36.7 35-43.1 53.4c-1.6 4.6-2.6 9-2.9 12.8a119 119 0 0 1 12.1-3.4l6.9-1.5l3.1 6.3a120.6 120.6 0 0 1 7.1 17.9c8.5-0.9 15-3.4 19.9-6.6c7.5-5 11.9-12.1 13.8-21.1c3.5-16.3-2.6-38.9-17-57.7M91.5 341.5c-9.3 23.1-9 47.9-0.7 63.5c4.6 8.6 11.1 14.6 20.3 17.6c4.6 1.5 10 2.2 16.2 1.8c-2.1-11.2-2.8-23-1.8-34.9l0.6-7.1l7-1.1a129 129 0 0 1 13.5-1.3c0.6 0 1.1 0 1.7-0.1c-12.4-15.8-33.9-31.4-56.7-38.5m329 0c-22.8 7-44.3 22.7-56.7 38.5c0.6 0 1.1 0 1.7 0.1c4.5 0.2 9 0.6 13.5 1.3l7 1.1l0.6 7.1c1 12 0.4 23.8-1.8 34.9c6.2 0.4 11.6-0.3 16.2-1.8c9.2-3 15.7-8.9 20.3-17.6c8.3-15.7 8.6-40.4-0.7-63.5M199.7 361c-1.9 7.4-6 14-11.4 19.4a47 47 0 0 1-3.5 3.1c14.8 3.3 28.7 8.7 40.4 15.5c2.4-5.4 5.4-10.3 9.4-14.5C240 378.9 247.5 375 256 375s16 3.9 21.3 9.4c4 4.2 7 9.2 9.4 14.5c11.8-6.8 25.8-12.2 40.7-15.5a48 48 0 0 1-3.7-3.4c-5.2-5.3-9.3-11.9-11.3-19zM256 393c-3.4 0-5.6 1.1-8.3 3.9s-5.4 7.5-7.5 13.3c-4.3 11.6-6.3 27-7.2 38.4c-1.1 15 3 33.4 12.3 40.1c4.7 3.4 16.7 3.4 21.5 0c9.3-6.7 13.4-25 12.3-40.1c-0.8-11.4-2.9-26.9-7.2-38.4c-2.1-5.8-4.8-10.5-7.5-13.3c-2.7-2.8-4.9-3.9-8.3-3.9m-103.5 5q-2.6 0-5.1 0.1c-1.4 0.1-2.8 0.3-4.2 0.4c-0.4 27.8 9.8 53.5 25 66.6c8.3 7.1 17.6 10.8 28.4 10.2c5.9-0.3 12.4-2 19.4-5.5c-1.3-7.7-1.4-15.4-0.9-22.4c0.6-8.9 1.9-20 4.5-30.9c-17.2-10.7-42.4-18.4-67-18.5zm207 0c-24.6 0.1-49.9 7.8-67 18.5c2.6 10.9 3.8 22 4.5 30.9c0.5 7 0.4 14.7-0.9 22.4c7 3.5 13.5 5.2 19.4 5.5c10.8 0.6 20.1-3 28.4-10.2c15.2-13.1 25.4-38.8 25-66.6c-1.4-0.1-2.8-0.3-4.2-0.4a116 116 0 0 0-5.1-0.1",
  "light-bulb":"M247 18.7c-81 0-146.9 65-146.9 145.6c0 45.6 15.8 67 33.3 94.8c11.7 18.6 23.8 39.9 30.5 70.6h165.1c6.7-31.4 18.9-53.1 30.7-71.9c17.6-27.9 33.3-48.9 33.3-93.5c0-80.7-65.1-145.6-146.1-145.6zm-99.8 127.9L170.4 167L210 201.8l31.2-34.1l6.8-7.4l6.9 7.3l30.8 32.7l40-33.5l22.7-19l-7.7 28.6L304.8 310.3l-18.1-4.8l28.2-105.2l-24 20.1l-6.8 5.7l-6-6.4l-29.9-31.8l-30.6 33.4l-6.2 6.8l-6.9-6.1l-23.2-20.4l27.9 104.2l-18.1 4.8l-35.9-134.1l-8-29.9zm22.6 201.8V389.5L315 348.4zm153.6 17.1l-153.6 43.5v29.4l153.6-43.5v-29.5zm0 48.9L204 448.2h119.4zm-132.6 52.5v20.5h113.3v-20.5h-113.3z",
  "lightning-dome":"M256 55c-68.5 0-126.7 50.7-167.6 116.2S23 317.7 23 384v3.7l2.6 2.7C76.5 441.2 166.4 465 256 465s179.5-23.8 230.4-74.6l2.6-2.7V384c0-66.2-24.4-147.3-65.4-212.8C382.7 105.7 324.5 55 256 55m0 18c39.4 0 76.3 19.9 108.1 51.5l-15.2 92.1l26.7 12.3l-37.2 116.6l74-120.1l-29.4-24.2l16-34.6c3.2 4.6 6.4 9.3 9.4 14.2C446.6 242 470 319 470.9 380.1C425.1 423.7 340.7 447 256 447S86.9 423.7 41.1 380.1c0.8-54 19.2-120.4 49.8-177.4l48.8 44.6l-42.1 3.5L177 355.4l-40.1-92l38.7 15.5l-57.9-119c29.5-40.4 65.5-70.9 105.1-82.2l-17 77.6l39.3-7.1l-32.3 95.6l35.1-12.7l0.6 123L291.4 189l-38.6 15.5l30.2-97l-34.4 4.2l5.4-38.7c0.7 0 1.3 0 2 0",
  "mailed-fist":"M215.8 21.1c-1.3 0-2.6 0-3.8 0.1a44 44 0 0 0-5.5 0.7L171.5 82.5a53 53 0 0 1 13.3-1.7c21.4 0 39.9 12.8 48.4 31.1l39.2-67.8c-4.5-5.8-14.7-13.1-27-17.5c-9.7-3.5-20.5-5.5-29.7-5.5zm85.7 17.5c-1.6 0-3.1 0-4.5 0.2l-44.5 77.2a53 53 0 0 1 15.2-2.2c20.8 0 38.9 12.1 47.7 29.5l43.2-74.8c-4.1-6.9-13.9-15.7-25.8-21.5c-10.4-5.2-22.2-8.1-31.3-8.3zm-162.5 29.3c-10.9 0.2-21.4 4.1-32.5 12.2C96 87.8 85.3 99.3 74.2 114.5L122 130.8l34.7-60c-5.4-1.8-10.6-2.7-15.5-2.8c-0.7 0-1.5 0-2.2 0zM370.3 85.5L325.5 163.2c5.3-1.8 11-2.8 16.9-2.8c20.3 0 38 11.6 46.9 28.5l37-64c-3.6-8.5-12.9-19.3-24.2-27C391.2 90.3 378.7 85.8 370.3 85.5zm-185.5 14c-19.3 0-34.7 15.4-34.7 34.8s15.4 34.8 34.7 34.8s34.7-15.4 34.7-34.8c0-19.3-15.4-34.8-34.7-34.8zM58.5 128.9C48.3 179.4 49.3 231 64.6 275c0.2 0.5 0.4 1.1 0.6 1.6l0.2-0.2l7.1 10.2c0.9 1.2 1.8 2.5 2.8 3.8c-0.8-41.2 10.5-89.2 37.4-143L58.5 128.9zm209.2 3.4c-19.3 0-34.7 15.4-34.7 34.7c0 19.3 15.4 34.8 34.7 34.8c19.3 0 34.7-15.4 34.7-34.8s-15.4-34.7-34.7-34.7zm169.3 12.7l-41.8 72.4c0 0.6-0.1 1.2-0.2 1.8a49.5 49.5 0 0 1 13.4-1.9c21.3 0 39.6 13.6 46.7 32.4l36.5-63.2c-3.4-8.9-12.6-20.1-23.8-28.3c-10.6-7.8-22.8-12.6-31-13.2zm-303.7 3.2C99.9 212 89.9 266.3 95.3 308.9c0.1 1 0.3 2.1 0.4 3.1c20.1 17.9 47.2 35.9 76.2 51.7c40.2 21.8 84.1 39.9 118.1 50.1c42-15.2 84.3-46.5 119.2-96.5c-0.3 0-0.5 0-0.8 0c-27.5 0-49.9-22.5-49.9-50c0-1.2 0.1-2.5 0.2-3.7a52.6 52.6 0 0 1-16.2 2.6c-28.3 0-51.6-22.5-52.9-50.5a52.9 52.9 0 0 1-21.8 4.7c-25.7 0-47.2-18.4-52.2-42.6c-8.7 6.1-19.3 9.8-30.7 9.8c-24.5 0-45.3-16.8-51.5-39.4zM342.4 179c-19 0-34.3 15.2-34.3 34.3s15.2 34.3 34.3 34.3c19 0 34.3-15.2 34.3-34.3c0-19.1-15.2-34.3-34.2-34.3m66 57.1c-17.4 0-31.2 13.9-31.2 31.3c0 17.4 13.9 31.3 31.2 31.3c17.4 0 31.2-13.9 31.2-31.3c0-17.4-13.9-31.3-31.2-31.3zM64.9 307.2a506 506 0 0 0-20.3 28.5c3.2 9.2 10.1 19.4 20.7 30c13.9 13.9 33.8 28 57.8 41.1c41.6 22.6 95.5 41.9 152 52.5a312 312 0 0 0 8.2-28.2c-35.4-10.7-79.2-28.7-120.2-50.9c-39.4-21.4-75.7-46.2-98.2-72.8zM32.7 354.6c-4.4 7.5-8.5 14.9-12.1 22.1c1.5 9.1 8 20.2 19.6 31.7c12.2 12.1 29.8 24.6 51.1 36.1c41.1 22.2 95.8 40.7 152.2 49.2h17.4a304 304 0 0 0 7.5-16.6c-57.3-11.1-111.5-30.6-154.2-53.9c-25.2-13.7-46.4-28.6-62.1-44.3c-7.9-7.9-14.5-16-19.3-24.3zm-14.5 57.5v34.1c1 2.3 3.2 5.5 6.9 9c5.3 5 13.2 10.4 22.8 15.5c18.9 10 44.4 18.7 70.6 22.9H161c-28.8-9.1-55.5-20.3-78.6-32.8c-22.4-12.1-41.3-25.3-55.4-39.2c-3.2-3.1-6.1-6.3-8.8-9.6zm0 61.8v19.8h34.3c-4.7-2-9.1-4.2-13.3-6.4c-7.9-4.2-15-8.6-21-13.3z",
  "medal":"M140.5 19.2V192.3l21.8 28.5h15.5V19.2zm56 0v201.7h122.1V19.2zm140.8 0v201.7h12.3l22.1-28.5V19.2zM173.9 239.5v18.1h164.1V239.5zm30.8 36.8l8 10.5c-25.3 12-45.1 33.5-55.1 59.8l65 47.5l5.5 4l-2.1 6.4l-17.3 53.7l45.7-33.1l5.5-4l5.5 4l62.5 45.2c24.9-20 40.8-50.6 40.8-85.1c0-6.5-0.6-12.9-1.7-19l-58.8 42.9l-11-15.1L361.7 347c-10.7-28.6-32.9-51.4-61.1-62.8l6.1-7.9h-38.8l-25.5 78l-17.8-5.8l23.6-72.2h-43.5zm-52.4 89.6a110 110 0 0 0-1.7 19.4c0 32.2 13.8 61 35.9 80.9l19.7-61l-53.9-39.3zm107.6 78.3l-51.5 37.3c15.3 8.1 32.7 12.7 51.2 12.7c18.7 0 36.2-4.7 51.6-12.9l-51.3-37.1z",
  "medal-skull":"M248.6 20.8c-43.5 0.1-87.3 4.4-131.6 13.8v54c93.5-27.5 193.6-20.2 277.8 0.8V35c-45.6-8.4-91.4-13.6-137.6-14.1c-2.9 0-5.8 0-8.7 0zm-3.7 68.5c-12.2 0.1-24.5 0.6-36.8 1.6V289.5c14.5-5.9 30.8-9.1 47.8-9.1c16.6 0 32.5 3.1 46.8 8.7l0-196.9c-17.3-1.7-34.9-2.7-52.6-2.8c-1.7 0-3.5 0-5.2 0zm-55.4 3.5c-14.6 1.8-29.1 4.2-43.4 7.4v180.7l33.2 25.5c3.2-2.6 6.7-5.1 10.2-7.4V92.8zm131.9 1.4v204.2a106 106 0 0 1 10.4 7.4l31-24.8V101.1a618 618 0 0 0-41.4-6.9zm-65.4 204.8c-50.7 0-89.8 32.8-89.8 70.8c0 24.1 15.8 46.1 40.4 59l-17.4 60.2l17.9 5.2l12.5-43l24.5 0v44.8h18.7v-44.8h25.1l12.5 43l17.9-5.2l-16.8-58.2c26.8-12.5 44.3-35.5 44.3-61c0-38-39.1-70.8-89.8-70.8m-55.3 41l44 48.4l-52.1-6.9l8.1-41.5zm109.7 0l8.1 41.5l-52.1 6.9l44-48.4zm-55.7 61.7l15.1 29.5h-30.1l15.1-29.5z",
  "medallist":"M75.4 28.4L27 52.5C42.6 99.3 61.5 155.6 80.4 206.9c19.9 53.8 40.2 101.9 55 124.1l1.2 1.9L152.1 487h91.3C227 481.6 215 466.1 215 448c0-4.9 0.9-9.6 2.4-13.9c-1.6-3.1-3.2-6.4-4.8-9.9c-7.6-16.7-14.5-37.3-20.3-58.8c-10.2-37.7-17.3-77.7-18.9-104.5c-9-14.8-17.4-31.4-25.5-49c-26.9-58.6-49.9-129.1-72.4-183.4m361.3 0c-22.5 54.3-45.5 124.8-72.5 183.4c-8.1 17.7-16.5 34.2-25.5 49c-1.6 26.8-8.8 66.9-18.9 104.5c-5.8 21.6-12.7 42.2-20.3 58.8c-1.6 3.5-3.2 6.8-4.8 9.9A40.6 40.6 0 0 1 297 448c0 18.1-12 33.6-28.4 39h91.3l15.4-154.1l1.2-1.9c14.8-22.3 35.1-70.3 55-124.1c19-51.3 37.8-107.6 53.4-154.3zM256 105c-18.7 0-36 10.5-49.2 29S185 178.8 185 208s8.5 55.5 21.8 74S237.3 311 256 311s36-10.5 49.2-29S327 237.2 327 208s-8.5-55.5-21.8-74S274.7 105 256 105m-59.8 192.8c3.2 19.7 7.8 41.7 13.5 62.8c5.7 20.9 12.3 40.8 19.3 56c0.1 0.1 0.1 0.3 0.2 0.4a41.1 41.1 0 0 1 13.5-7.8c-6.7-14.7-12.6-33.4-17.4-51.4c-4.3-16.1-7.5-30.5-9.1-41.5c-7.4-5-14.1-11.3-20-18.5zm119.6 0c-5.9 7.3-12.6 13.5-20 18.5c-1.6 11-4.8 25.4-9.1 41.5c-4.8 18.1-10.8 36.7-17.4 51.4a41.1 41.1 0 0 1 13.5 7.8c0.1-0.1 0.1-0.3 0.2-0.4c7-15.2 13.6-35.1 19.3-56c5.7-21.1 10.3-43.2 13.5-62.8zm-79.4 28.3c1.6 8.2 3.7 17.6 6.3 27.1c3.8 14.2 8.5 29.2 13.3 41.3c4.8-12.2 9.5-27.1 13.3-41.3c2.5-9.5 4.7-19 6.3-27.1c-6.3 1.9-12.8 2.9-19.6 2.9s-13.3-1-19.6-2.9M256 425c-12.8 0-23 10.2-23 23s10.2 23 23 23s23-10.2 23-23s-10.2-23-23-23",
  "meditation":"M263.4 19.4c-11.8 0-22.7 6.1-31.2 17.2c-7.3 9.5-12.4 22.5-13.7 37.2c11.1-4.9 22.5-7.9 33.8-9V83.2c-11 1.4-22 5-33.2 11c2 12.5 6.7 23.5 13.1 31.8c8.5 11.1 19.4 17.2 31.2 17.2s22.7-6.1 31.2-17.2c6.2-8.1 10.8-18.7 12.8-30.7c-12.1-6.8-24.2-11-36.4-12.3V64.8c12.7 1.1 25.2 4.5 37.3 10.2c-1.2-15.2-6.3-28.6-13.8-38.3c-8.5-11.1-19.4-17.2-31.2-17.2zm-46.6 117.2c-10.4 4.8-18.4 11.2-22.6 18.5l-0.4-0.1l-41.6 64.4l-50.7-22c-29.4-16.1-61.6 24-30.6 41.7l94.5 44.1l38-50.1c18.7 33.7 16.8 67.4-11 101.2c-8.3-0.6-16.4-1-24-0.9c-40.3 0.3-68.9 10.3-73.9 28.8l0 0c-4.4 16.6 11 36.7 39.1 55.3c55.7 29.3 95.4 38.5 157 42.3h1.6l0.4 0.1c0.4 0 0.8 0.1 1.2 0.1l0 0.3l92.1 28.7l-22.2-53.7L183.6 375.5l5.9-17.7l71.8 23.8l71.8-23.8L339 375.5l-48.1 16l94.4 31.4c33.5-20 52.5-42.5 47.7-60.7c-6-22.2-45.9-32.1-99.2-27.8c-26.4-33.2-26.2-66.4-9.5-99.6L361 283.2l94.5-44.1c30.9-17.7-1.2-57.8-30.6-41.7l-50.7 22L332.6 155h-0.1c-4.2-7.2-12.1-13.6-22.5-18.4c-0.2 0.3-0.4 0.5-0.6 0.8c-11.3 14.7-27.6 24.6-46 24.6s-34.7-9.8-46-24.6c-0.2-0.3-0.4-0.5-0.6-0.8m-63.7 311l-16.7 40.5l69.9-21.8c-17.6-4.6-34.9-10.6-53.2-18.7",
  "money-stack":"M327 65.8L229.8 128.2l9.9 5.4l86.5-55.5l146.7 83.1l-84.2 54l4.1 2.2v6.8l65.9-42.3l13.8 7.8l-79.8 51.2v11.7l64.6-41.5l15.1 8.6l-79.8 51.2v11.7l64.6-41.5l15.1 8.6l-79.8 51.2v11.7l100-64.2l-24.8-14.1l24.8-15.9l-24.8-14.1l24.8-15.9l-23.5-13.3l23.8-15.3zm31.1 44.7c-21 10.6-49.1 12.3-68.8 4.4l-38.6 24.8l126.9 69.5l36.6-23.5c-14.4-11.4-13.2-28.4 2.9-41.7zM227.5 147.5l-70.7 46.1l135.6 78.1l1.3-0.8c2.5-1.6 6-3.9 10.2-6.6c8.4-5.4 19.6-12.7 30.7-19.9c16-10.4 24.2-15.7 31.9-20.7zm115.5 1.2a8.6 14.4 82.1 0 1 0 0a8.6 14.4 82.1 0 1 8.3 1.9a8.6 14.4 82.1 0 1-0.9 12.3a8.6 14.4 82.1 0 1-20.3 1.3a8.6 14.4 82.1 0 1 0.9-12.3a8.6 14.4 82.1 0 1 11.9-3.2m-218.4 47.1L19.1 263.4l23.5 13.3l-23.8 15.3l24.8 14.1l-24.8 15.9l24.8 14.1l-24.8 15.9l166.1 94.1L285.3 381.8v-11.7l-99.4 63.8L39.1 350.8l14.3-9.2l131.6 74.5L285.3 351.8v-11.7l-99.4 63.8L39.1 320.8l14.3-9.2l131.6 74.5L285.3 321.8v-11.7l-99.4 63.8L39.1 290.8l13.3-8.5l132.9 75.3l100-64.2v-5l-5.5-3.2l-93.7 60.1l-146.7-83.1l94.8-60.8l-9.6-5.5zm20.5 11.8l-46.9 30.1c14.4 11.4 13.2 28.3-2.9 41.7l59.1 33.5c21-10.6 49.1-12.3 68.8-4.4l46-29.5l-124-71.4zm229.8 32.2c-8 5.2-15.1 9.8-30.4 19.7a36222 36222 0 0 1-30.7 19.9c-4.2 2.7-7.8 5-10.3 6.6c-0.1 0.1-0.1 0.1-0.2 0.1v85.9l71.5-48.1zm-201 17.5a8.6 14.4 82.1 0 1 8.3 1.9a8.6 14.4 82.1 0 1-0.9 12.3a8.6 14.4 82.1 0 1-20.3 1.3a8.6 14.4 82.1 0 1 0.9-12.3a8.6 14.4 82.1 0 1 11.9-3.2z",
  "muscle-up":"M165.9 18.7C15.6 59.3-42.2 198.6 92.7 245.4h-1.1c0.6 0.1 1.3 0.2 1.9 0.3c9 3.1 18.8 5.7 29.5 7.9C173.4 273.4 209.7 321.2 212.7 368c-33.5 23.1-59.5 62.8-59.5 62.8l26.3 38.7L138.3 493h82c-40.4-40.4-11.8-85.9 36.1-85.9c48.5 0 73.9 48.1 36.2 85.9h81.1l-40.4-23.5l26.3-38.7s-26.4-40.4-60.3-63.4c3.2-46.6 39.5-94.2 89.6-113.8c10.7-2.2 20.5-4.9 29.5-7.9c0.6-0.1 1.3-0.2 1.9-0.3h-1.1c134.9-46.8 77.2-186.1-73.2-226.7c-40.7 39.4 6.5 101.7 43.6 56.9c36.9 69.1 8.6 127.6-72.3 83.4c-11.9 24.5-34.2 41.4-60.7 41.4c-26.7 0-49.2-17.2-61-42c-81.8 45.4-110.5-13.4-73.4-82.8c37.1 44.8 84.3-17.5 43.6-56.9zm90.8 35.9c-27.4 0-51.3 27.6-51.3 63.6c0 36.1 23.9 63 51.3 63s51.3-26.9 51.3-63c0-36.1-23.9-63.6-51.3-63.6z",
  "notebook":"M131.3 20.4c-14.6 0.1-28.1 10-31.9 24.8c-2.3 9.1-0.6 18.4 4.1 25.8c-7.7 4.3-13.7 11.5-16 20.7c-2.3 9.1-0.6 18.3 4.1 25.8a32.7 32.7 0 0 0-16 20.6c-2.3 9.1-0.5 18.4 4.2 25.8c-7.7 4.3-13.8 11.5-16.1 20.7c-2.3 9.1-0.5 18.4 4.2 25.8c-7.7 4.3-13.8 11.5-16.1 20.7c-2.3 9.1-0.5 18.4 4.2 25.8c-7.7 4.3-13.8 11.5-16.1 20.7c-2.3 9.1-0.5 18.4 4.2 25.8c-7.7 4.3-13.8 11.5-16.1 20.7c-2.4 9.2-0.5 18.5 4.3 26a32.9 32.9 0 0 0-16.3 20.8c-4.5 17.5 6.2 35.6 23.8 40.1l0.1-0.2l31.7 8.2l-1.5 5.7l261.6 67L374 326.5l-22.4 21.2l-87.8 26.5l15.5-42.5l-151.7-38.8l4.4-17.4l153.5 39.3l9.7-26.7l15.3-14.4l-167-42.8l4.4-17.4l178 45.6l39.6-37.4l-206.1-52.8l4.4-17.4L380.7 207l-0.1 0.4l31.5-29.8l18.3-71.4l-261.6-67l-4.8 18.7c2.2-16.3-8.1-32.3-24.5-36.4c-2.7-0.7-5.5-1-8.2-1m0.3 18c1.2 0 2.4 0.2 3.5 0.5c8.1 2.1 12.9 10.1 10.8 18.3l17.2 4.4l-11 42.8c2.2-16.4-8.2-32.3-24.5-36.4l-0.6-0.1c-7.8-2.3-12.2-10.2-10.2-18.1c1.7-6.6 7.3-11 13.7-11.3h1.1zm-11.9 46.5c0.9 0 1.9 0.1 2.9 0.4l0.6 0.1c8.1 2.1 12.9 10.1 10.8 18.2l17.2 4.4l-11 43c2.4-16.4-8-32.6-24.4-36.7c-0.7-0.2-1.3-0.4-1.9-0.5c-7-2.7-10.9-10.1-9-17.6c1.7-7 7.9-11.4 14.8-11.3zm59.9 4.6l217 55.7l-4.4 17.4l-217-55.6zm-72.9 41.9h1.3c0.5 0 0.9 0 1.4 0.1c0.6 0.2 1.2 0.3 1.8 0.5l0.1-0.2c8.1 2.1 12.9 10.1 10.8 18.3l17.2 4.4l-11 43c2.3-16.3-8.1-32.4-24.4-36.6c-8.2-2.1-12.9-10.1-10.8-18.3c1.7-6.6 7.2-10.9 13.7-11.2M465.4 152l-10.2 9.6l31.6 33.5l10.2-9.6zm-23.3 22L315.7 293.5l31.5 33.5l126.5-119.5zm-347.2 3.7c1.5 0 3 0.1 4.5 0.5c8.1 2.1 12.9 10.1 10.8 18.3l17.2 4.4l-11 43c2.3-16.4-8.1-32.4-24.4-36.6c-8.1-2.1-12.9-10.1-10.8-18.3c1.7-6.6 7.3-11 13.7-11.3m-11.9 46.5c1.5 0 3 0.1 4.5 0.5c8.1 2.1 12.9 10.1 10.8 18.3l17.2 4.4l-11 42.9c2.3-16.3-8.1-32.3-24.4-36.5c-8.1-2.1-12.9-10.1-10.8-18.3c1.7-6.6 7.3-11 13.7-11.3m-11.9 46.5c1.5 0 3 0.1 4.5 0.5c8.1 2.1 12.9 10.1 10.8 18.3l17.2 4.3l-10.9 42.8c2.2-16.3-8.2-32.1-24.5-36.3c-8.1-2.1-12.9-10.1-10.8-18.3c1.7-6.6 7.3-11 13.7-11.3m235.3 39.2L293 346.6l37.4-11.3zm-247.2 7.3c1.5 0 3 0.1 4.5 0.5c8.1 2.1 12.9 10.1 10.8 18.3l17.2 4.3l-11 43c2.1-16.2-8.3-32-24.5-36.2l0.1-0.3c-8.2-2.1-12.9-10.1-10.8-18.3c1.7-6.6 7.3-11 13.7-11.3m57 20.3L333.2 393l-4.4 17.4l-217.1-55.5zM47.2 364c1.5 0 3 0.1 4.5 0.5c8.1 2.1 12.9 10.1 10.8 18.3l17.2 4.3l-3.7 14.4l-31.9-8.2v0.2c-8-2.2-12.7-10.1-10.6-18.2c1.7-6.6 7.3-11 13.7-11.3z",
  "on-target":"M107.6 21.4c122.5 187.6 107.7 216.2-75 55.8c83.3 103.7 183.1 185.7 287.9 260.8c-47.7 54.8-65.5 116.2-39.3 141.4c27.9 26.8 95.3 2.3 150.2-54.9s76.7-125.5 48.7-152.4c-26.4-25.3-87.7-4.6-140.7 46C267.5 213.8 194.6 110.6 107.6 21.4zm324.9 266.8c9.9-0.1 18.2 2.5 24.2 8.3c21.4 20.5 4.9 72.8-37.1 116.6c-42 43.8-94 62.8-115.3 42.3c-20-19.1-6.3-66 29.7-107.8c3.7 2.6 7.4 5.3 11.1 7.9c-26.5 31.1-36.2 65.5-21.4 79.8c16 15.4 54.6 1.3 86.2-31.5c31.5-32.8 44-72 28-87.4c-15.2-14.6-50.6-2.5-81.1 26.8c-2.6-3.8-5.2-7.5-7.8-11.3c28.5-27.3 60.2-43.3 83.5-43.6zm-22 37.4c5.7-0.1 10.5 1.4 13.9 4.8c12.3 11.8 2.8 41.8-21.3 66.9c-24.1 25.1-53.9 36-66.2 24.2c-11.2-10.8-3.9-36.9 16-60.6c6 4.2 12 8.3 18 12.5c-9.7 11-14 22.7-9.6 27.1c4.9 4.9 18.5-0.7 30.3-12.6s17.5-25.5 12.6-30.4c-4.8-4.8-17.8 0.5-29.4 11.7q-6.3-9.1-12.6-18.3c16.5-15.9 34.8-25.2 48.2-25.4z",
  "open-book":"M149.7 85.6c-1.2 0-2.5 0-3.7 0.1c-33.9 0.8-75.5 10.7-127.2 33.7V362.8c60.8-28.8 106.7-37.1 144.2-33.1c33.5 3.5 59.7 16.7 83.6 31.2v-243c-23.2-17.7-50.2-30-86-32a185 185 0 0 0-10.8-0.3zm212 0c-3.7 0-7.3 0.1-10.8 0.3c-35.8 2-62.8 14.3-86 32v243c23.9-14.5 50.1-27.6 83.6-31.2c37.5-4 83.5 4.3 144.2 33.1V119.4c-51.8-23-93.3-32.9-127.2-33.7c-1.3 0-2.5-0.1-3.7-0.1zm5.7 261.8c-1 0-2.1 0-3.1 0c-4.8 0.1-9.4 0.4-13.9 0.8c-33.9 3.6-59.6 18-85.5 34.4v0.3c-6.6-2-13-2.4-19.4-1c-25.6-16.2-51-30.2-84.5-33.8c-5.6-0.6-11.4-0.9-17.6-0.8c-32 0.2-71.8 9.8-124.7 35.9v42.5c60.8-28.8 106.7-37.1 144.2-33.1c18.5 2 34.8 6.8 49.8 13.3c-4.7 6.1-9.3 13.3-13.9 21.7h117.2c-5.9-8.2-11.8-15.4-17.6-21.6c15-6.5 31.4-11.4 50.1-13.4c37.5-4 83.4 4.3 144.2 33.1v-42.5c-53.2-26.3-93.1-35.9-125.2-36z",
  "over-infinity":"M256.9 21.9c-8.8 0-17.5 5.5-24.6 16.4c-7.1 10.9-11.9 27-11.9 44.8c0 17.8 4.8 33.8 11.9 44.8c7.1 10.9 15.8 16.4 24.6 16.4s17.5-5.5 24.6-16.4c7.1-10.9 11.9-26.9 11.9-44.8s-4.8-33.8-11.9-44.8c-7.1-10.9-15.8-16.4-24.6-16.4zm-92.9 53L24.8 263.3L164 451.7l93.3-126.3l0.1 0.1l89.1-120.6l7.5-10.2l7.5 10.2l46.4 62.8l-15 11.1l-38.9-52.6l-85 115l81.6 110.5L489.8 263.3L350.6 74.9l-93.3 126.2l-0.1-0.2l-90.8 122.9l-7.5 10.2l-7.5-10.2l-46.4-62.8l15-11.1l38.9 52.6l86.8-117.4L164 74.9z",
  "overlord-helm":"M183.2 20.1c-19.6 65.3-41.6 129.7-30.4 186.1l0.4 1.8l-16 80.1l15.4 92.2L234.2 488.4l12-83.5L224 416c-16-32-16-64 0-80l-48-16v-64c10.4 10.4 34.3 27.5 54.1 38.3l-15.6-54.5l0.7-2.1l-31.5-9l-0.6-208.6zM329 22.8v205.7l-32.3 9.2l0.7 2.1l-15.6 54.5C301.7 283.5 325.6 266.4 336 256v64l-48 16c16 16 16 48 0 80l-22.2-11.1l12 84.3l81.6-108.9l15.4-92.2L358.8 208l0.4-1.8C370.3 150.7 348.2 87.2 329 22.8m-73 49.8l-7 56v64.9l-15.6 46.7L256 319.2l22.6-79L263 193.5v-64.9zm25 110.9v7.1l10 30.1l20-5.7v-17.3c-12.3-6.1-22-10.8-30-14.2zm-50 0c-7.9 3.3-17.4 7.9-29.3 13.8l0.1 17.9l19.2 5.5L231 190.5zM192 288v16l32 16zm128 0l-32 32l32-16zM26 372.3c-4.9 23.5-7.4 47.2-4 72.9c10.9-5.4 22.3-9 34-10.9c-12.4-17.3-22.4-38.7-30-62zm460 0c-7.6 23.2-17.5 44.7-30 62c11.7 1.9 23.1 5.5 34 10.9c3.4-25.6 0.9-49.4-4-72.9zm-396 9.8c-3.1 14.7-5.2 29.5-5.5 44.8c5.5-4.3 11.3-8.8 18.1-12.7c-4.8-10.1-9-20.9-12.6-32.1m332 0c-3.7 11.2-7.9 22-12.6 32.1c6.8 3.9 12.6 8.4 18.1 12.7c-0.3-15.3-2.5-30.1-5.5-44.8zm-290.4 41.7c-7.6 0.1-13.6 2.4-19.6 5.8c-5.2 2.9-10.4 6.9-15.8 11l106.1 63.2l-63.1-79.3c-2.1-0.3-4.2-0.7-6.1-0.7q-0.8 0-1.5 0zm247.2 0c-1.9 0-4 0.4-6.1 0.7l-63.1 79.3l106.1-63.2c-5.4-4.2-10.6-8.1-15.8-11c-6.4-3.6-12.8-6-21.2-5.8m-301.2 26.7c-21.3 0.1-40.8 5.3-58.9 17.4l4.6 19.6l132.6 10l-61-36.6l0.1 0l-8.9-5.3l0 0.1zm356.8 0l-8.4 5.1l0-0.1l-8.9 5.3l0.1 0l-61 36.6l132.6-10l4.6-19.6c-18.1-12.1-37.6-17.3-58.9-17.4z",
  "present":"M149.5 78.4c-6.5 0.1-12.4 1.7-17.4 4.9c-7.5 4.8-11.8 12.9-13.1 21.3c-2.6 16.9 4.7 36.4 19.9 52.3C154.1 172.9 177.6 185 208 185h2.4l-9.1-18.2c-22.2-1.6-38.5-10.8-49.3-22.2c-11.9-12.5-16.5-28.1-15.1-37.2c0.7-4.6 2.4-7.2 5.1-9s7.1-2.9 14.8-1.3c13.1 2.6 34.2 13.9 62.2 39.3L220.3 135h23.4c-35.3-34.8-62.2-51.3-83.4-55.6a52 52 0 0 0-7.9-1q-1.4-0.1-2.8 0zm213 0q-1.4 0-2.8 0c-2.6 0.1-5.2 0.5-7.9 1c-21.2 4.3-48.1 20.8-83.4 55.6h23.4l1.4 1.4c28-25.3 49.1-36.6 62.2-39.3c7.6-1.6 12.1-0.4 14.8 1.3s4.4 4.4 5.1 9c1.4 9.1-3.3 24.6-15.1 37.2c-10.8 11.4-27.1 20.7-49.3 22.2L301.6 185H304c30.4 0 53.9-12.1 69-28.1c15.1-16 22.5-35.4 19.9-52.3c-1.3-8.4-5.6-16.5-13.1-21.3c-4.9-3.2-10.8-4.8-17.4-4.9M227.7 153l-8.8 8.8L229.6 183h52.9l10.6-21.2l-8.8-8.8h-56.5zM73 201v46h142v-46zm160 0v270h46V201zm64 0v46h142v-46zm-192 64v206h110V265zm192 0v206h110V265z",
  "rank-1":"M255 471L91.7 387V41h328.6v346zm-147.3-93.7L255 453l149.3-75.8V57H107.7zm146.6-33.1l-94.7-48.7v50l94.5 48.6l98.3-49.9v-49.9z",
  "rank-2":"M255 471L91.7 387V41h328.6v346zm-147.3-93.7L255 453l149.3-75.8V57H107.7zm146.4-65.8l98.3-49.9v-49.9l-98.1 49.8l-94.7-48.7v50zm0.1 32.7l-94.7-48.7v50l94.5 48.6l98.3-49.9v-49.9z",
  "rank-3":"M255 471L91.7 387V41h328.6v346zm-147.3-93.7L255 453l149.3-75.8V57H107.7zm187.6-168.3l-14.5-46l38.8-28.7l-48.3-0.4L256 87.9l-15.3 45.8l-48.3 0.4l38.8 28.7l-14.5 46l39.3-28zM254.1 311.5l98.3-49.9v-49.9l-98.1 49.8l-94.7-48.7v50zm0.1 32.7l-94.7-48.7v50l94.5 48.6l98.3-49.9v-49.9z",
  "receive-money":"M258 21.9c-0.5 0-1.2 0-1.8 0.1c-4.6 0.8-10.1 5.1-13.7 14.8c-3.8 9.7-4.6 23.5-1.3 38.3c3.4 14.6 10.4 27.2 18.2 34.9c7.6 7.7 14.5 9.8 19.1 9c4.8-0.7 10.1-5.1 13.7-14.7c3.8-9.6 4.8-23.7 1.4-38.4c-3.5-14.8-10.4-27.3-18.2-34.9c-6.6-6.8-12.7-9.2-17.4-9.2M373.4 151.4c-11 0.3-24.9 3.2-38.4 8.9c-15.6 6.8-27.6 15.9-34.2 24.5c-6.6 8.3-7.2 14.6-5.1 18.3c2.2 3.7 8.3 7.2 20 7.7c11.7 0.7 27.5-2.2 43-8.8c15.5-6.7 27.7-15.9 34.3-24.3c6.6-8.3 7.1-14.8 5-18.5c-2.1-3.8-8.3-7.1-20-7.5c-1.6-0.3-3-0.3-4.6-0.3m-136.3 92.9c-6.6 0.1-12.6 0.9-18 2.3c-11.8 3-18.6 8.4-20.8 14.9c-2.5 6.5 0 14.3 7.8 22.7c8.2 8.2 21.7 16.1 38.5 20.5c16.7 4.4 32.8 4.3 44.8 1.1c12.1-3.1 18.9-8.6 21.1-15c2.3-6.5 0-14.2-8.1-22.7c-7.9-8.2-21.4-16.1-38.2-20.4c-9.5-2.5-18.8-3.5-27.1-3.4m160.7 58.1L336 331.7c4.2 0.2 14.7 0.5 14.7 0.5l6.6 8.7l54.7-28.5zm-54.5 0.1l-57.4 27.2c5.5 0.3 18.5 0.5 23.7 0.8l49.8-23.6zm92.6 10.8l-70.5 37.4l14.5 18.7l74.5-44.6zm-278.8 9.1a40.3 40.3 0 0 0-9 1c-71.5 16.5-113.7 17.9-126.2 17.9H18v107.5s11.6-1.7 30.9-1.8c37.3 0 103 6.4 167 43.8c3.4 2.1 10.7 2.9 19.8 2.9c24.3 0 61.2-5.8 69.7-9C391 452.6 494 364.5 494 364.5l-32.5-28.4s-79.8 50.9-89.9 55.8c-91.1 44.7-164.9 16.8-164.9 16.8s119.9 3 158.4-27.3l-22.6-34s-82.8-2.3-112.3-6.2c-15.4-2-48.7-18.8-73.1-18.8",
  "ribbon-medal":"M256.9 29.7L241.1 51.6l-23-14.1l-6.2 26.2l-26.6-4.2l4.3 26.6l-26.2 6.3l14.2 22.9l-21.8 15.9L177.6 147l-14.1 23l26.2 6.2l-4.2 26.6l26.6-4.3l6.3 26.2l22.9-14.2l15.9 21.8l15.8-21.9l23 14.1l4.3-18.1l1.9-8.1l26.6 4.2l-4.3-26.6l26.2-6.3l-14.2-22.9l21.8-15.9l-21.9-15.8l14.1-23l-26.2-6.2l4.2-26.6l-26.6 4.3l-6.3-26.2l-22.9 14.2l-15.9-21.8zm-0.3 51.7a49.7 49.6 0 0 1 49.7 49.6a49.7 49.6 0 0 1-49.7 49.6a49.7 49.6 0 0 1-49.7-49.6a49.7 49.6 0 0 1 49.7-49.6zm59.3 137.3l-8.1 34.2l-30-18.3l-9.7 13.5c11.7 82 18.1 163.8 54.7 247l16.6-66.2c10.5 13.8 27.5 26.1 49.7 33.1c-31.1-77.6-42.8-159-54.7-240.4zm-117.4 0.3l-19.8 3.2c-11.9 81.2-23.6 162.4-54.6 239.8c22.1-7 39.1-19.3 49.7-33.1l16.6 66.2c36.8-83.7 43-166 54.9-248.6l-8.6-11.8l-29.9 18.4l-8.2-34.1z",
  "rocket-flight":"m482.2 44.8l-50.5 46.2l-21.9 57.2c-34.6 15.4-48 24.4-61.5 74.9l39.6-17.7l-1.9 32.1l37.3 14.3l21.8-24.5l17.6 39.6c24.5-42.5 25.7-63.2 4.3-96.8l21.9-57.2l-6.7-68.2zM389.1 263.2c-16.3 25.2-38 48.6-63.1 68.2c0 0 0 0-0.1 0.1c-37.3 23.7-83.3 29.1-118.1 15.7c16.2 15.1 37.6 20.7 59.2 19.2c-49.4 14.9-102.3 9.1-139.6-14.3c14.1 19.3 34.5 31.2 57 36.6c-58.9 3.3-117.9-19.8-162.4-84l0 168c65.9 28.6 135.1 19.6 196.2-11.6l-17 35.8l88.1-85h-0.1c2-1.8 4-3.6 5.9-5.4l-11.3 43.9l59.8-99.4c19.7-27.6 35.3-57.4 45.4-87.7z",
  "running-shoe":"m135.6 38.4l-17 6.2c6.2 17 9.1 34.2 2.3 51.3c4.5 4.8 8.9 9.5 13.3 14.1c12.5-24.4 9.2-50.1 1.4-71.5m-25.8 72c-6.8 2.6-12.8 5.9-18.3 9.7c27.2 29.8 50.2 61.6 63.8 92.1c12.7 28.7 17.4 57.3 7.2 81.1l219.8 158.9c27.5-1.4 45.3-8.1 57.5-17.5c12.8-9.8 20.1-22.9 25.4-38.4c-2.9-3.2-6.1-6.3-9.6-9.4c-25.7 4.5-48.2-0.6-66.9-12.4c-19.5-12.2-34.8-31.1-47.8-53c-24.5-41.3-41-94-57.7-137.5c-44.5 4.5-77.1-1.7-102.7-14.2c-30.6-15-50.7-38.1-70.7-59.4m-31.9 21.5c-4.6 4.9-8.7 10.3-12.3 16.1c-10.6 16.7-17.8 37-24 57.9l105.8 76.5c5.7-17.1 2.3-38.5-8.6-62.9c-12.5-27.9-34.6-58.6-60.9-87.6m238.9 47c-5.2 1-10.2 1.9-15.2 2.7c3.7 9.7 7.4 19.7 11.1 29.8l26 13.1c-6.9-16.1-13.7-31.5-21.9-45.6m-285.3 42c-2.7 2.9-4.5 5.9-5.4 9c-1.2 4-1.1 8.4 1 13.8L266 398c21.8 14 41.4 25.6 59.2 35.1zm290.3 15.3c6.9 18.3 14.2 36.4 22.3 53.1l33.2 14.7c-11.2-18.1-19.8-36.1-27.5-53.7zm36.2 78.8c11.7 19.2 25 34.7 40.3 44.3c11 6.9 22.9 10.9 36.8 11.3c-14.8-12.4-27.1-25.2-37.6-38.2zm119.8 98.4c-5.9 13.3-14.2 25.8-27 35.6c-11.4 8.7-26 15.2-44.7 18.6c17.5 4.9 31.2 6.5 41.6 6.1c14.9-0.6 23.4-4.7 28.6-8.8s7.2-8.2 8.1-10.2c3.5-7.8 3.2-19.9-2.5-33.3c-1.1-2.6-2.5-5.3-4.1-8",
  "scroll-quill":"M311.9 48c-17.6 0-34.6 0.7-50.7 2.4L244.6 93.5l-4.9-40c-2.5 0.5-5 0.9-7.5 1.5c-9.1 1.9-15.1 7.2-20.3 14.9s-8.9 17.5-12.1 26.6C191 121.5 184 148 178.4 175c6 5.1 12 10.3 17.9 15.4l30.7-17.6l33.8 26.1l51.9-19.7l61 24.5l-6.8 16.7l-54.4-21.8l-54.7 20.7l-32.2-24.9l-14.9 8.5c19.6 17.3 38.6 34.4 56.5 51.2l14-6.4l33.9 16.1l31.2-13.1l24.2 23.3l-12.4 13l-15.8-15.1l-27.6 11.7l-33-15.8c6.9 6.7 13.6 13.2 20.1 19.7l1.7 1.8l19.5 76.3l-7.8-5.7l-53 0.4l-38.1-17.8l-42.4 14.6l-5.8-17l49.2-17l41.1 19.2l24.7-0.2l-70.7-51.7c-19.7 4.6-39.4 2.8-58.1-3.7c-4.2 44.4-5.9 85.7-7 118.7c-0.4 10.7 2.7 23 7.5 32.5c4.9 9.5 11.7 15.4 15 16.1c5.2 1.2 19 3.2 37.7 5.1l12.4-39l19.1 41.7c16.7 1.2 35 2 53.5 2.2c28.2 0.3 57.1-0.9 82-4.7c15.8-2.3 29.6-6 40.7-10.4c-11.8-5.1-21.6-10.6-29.1-16.6c-11.1-8.9-18.2-19.3-17.3-30.9v0.2c5.4-96.4 10.8-188.8 30.3-286l0.1-0.4l0.1-0.4c5.3-17.9 17.9-39.9 36.1-55.8c-13.9-2.1-28.6-4-43.7-5.7l-22.3 25.3l-2.2-27.7c-19-1.6-38.4-2.7-57.4-2.9h-5.7zm148.5 20.4c-4.7 3.7-9.2 8-13.3 12.7c12.1 8.2 21.4 23.4 21.8 37c0.3 7.8-1.9 14.9-7.7 21.4c-5.8 6.4-15.6 12.4-31.6 15.8l3.8 17.6c18.6-4 32.3-11.5 41.2-21.4c9-9.9 12.7-22.2 12.3-34c-0.6-19.3-11.1-37.6-26.5-49.1M25.4 71.9c-0.2 1.6-0.4 3.4-0.4 5.6c0.1 7.7 2 18.2 5.8 30.2c3.4 10.7 8.3 22.5 14.3 34.8c10.6-5.3 20.6-11 28.4-18.1c-4.4 12.5-10.2 24.7-18.6 36.5c4.1 7.2 8.6 14.4 13.4 21.5c10.6-5.3 20.7-13 29.5-26.1c-3.3 16-8.5 30.6-18.3 41.8c6.5 8.5 13.5 16.8 20.8 24.5c8.7-9.3 15.6-21 20.7-34.9c3.8 18.5 2.6 35.3-5.7 49.4c8 7.2 16.3 13.7 24.8 19.1c6.1-14 8.9-30.6 8.5-49.7c9.2 23.7 11.3 42.9 9.6 59.5c20.2 9.2 40.8 12 61.3 6.1l4.2-1.3l69.3 50.6l-5.9-22.8c-73-72.8-175.4-156.7-261.9-226.7M312.8 123.9l33.2 13.8l31.3-9.9l5.4 17.2l-37.5 11.9l-33.6-14l-28.8 8.1l-4.8-17.4zm107.3 236.2c-0.7 0-1.3 0.1-2 0.1c-3.5 0.1-7.2 0.5-11.1 1.3l3.4 17.6c12.2-2.3 20-0.4 24.5 2.5c4.4 2.9 6.3 6.8 6.4 12.5c0.1 9.3-7 23-23.3 32.5c5.4 2.9 11.9 5.9 19.3 8.7c14.4-11.6 22.1-26.8 22-41.4c-0.1-10.7-5.2-21.2-14.6-27.4c-6.7-4.3-15-6.5-24.6-6.4",
  "scroll-unfurled":"M103.4 17.8a87 87 0 0 0-3.3 0.1q-3.8 0.2-7.6 0.7c-20.2 2.7-39.2 13.7-52.3 33.7c-24.6 37.4 2.2 98 56.6 98c0.5 0 1.1 0 1.6 0v0.7h60.6c-10.8 32-30.3 66.6-52.4 101.4a283 283 0 0 0-6.3 10.4l34.9 35.7l-56.3 9.4c-32.7 86-27.4 182.1 48.3 182.1v0l9.3 0.1c23.8-0.6 46.7-4.3 61.3-12.9c4.2-2.5 7.6-5.2 10.5-8.4h-32.4c-20.3 6-40.8-6.9-47.4-25.9c-9-25.8 7.5-52.4 31.9-60.5a55.6 55.6 0 0 1 17.6-2.8v-0.4h178.3c-0.6-44.4 16.4-90.1 49.2-126c24-26.2 42-60.6 51.3-94.8l-41.2-24.9l38.3-6.9l-43.4-25.8h0l0 0l0 0l52.1-8.8c-5.2-39.1-28.8-68.1-77.4-68.1C341.1 32.3 222.1 35.3 149.3 28.5c-14.9-6.8-30.5-10.7-45.9-10.7m0.5 18.7c13.1 0 27.4 3.8 41.2 10.6l0-0.1c4.7 4.7 8.5 9.7 11.7 15H82.9l10.6 14.8c10.6 14.8 19.8 32 21.1 42c0.6 5-0.1 7.2-1.8 8.8c-1.7 1.7-6.2 3.9-16 3.9c-40.6 0-56.9-45-41-69.1C66.2 46.6 79.6 39.2 95 37.1a64 64 0 0 1 8.9-0.6M118.5 80.8h46.3c4.3 15.7 3.7 33.1-0.5 51.5H131.5c1.9-5 2.3-10.6 1.6-15.8c-1.5-11.9-7.4-24.1-14.6-35.7m101.6 317.1c6.4 6.8 11.2 15.3 13.4 24.9c3.8 16.7 3.1 31.2-1.8 43.2c-4.5 11.2-12.6 19.8-22.3 26h237.2c14.4 0 24.9-5.7 32.2-14.3c7.3-8.6 11.2-20.5 10.7-32.4a47.7 47.7 0 0 0-2.4-13.2l-69.9-8.2l42-20.5c-8.3-3.4-18.6-5.5-31.4-5.5H220.1zm-42.7 0.5a37 37 0 0 0-3.5 0.2a34.8 34.8 0 0 0-7.8 1.6c-15.1 5-25.3 21.5-20.1 36.6c3.7 10.6 15.3 17.7 25.7 13.9l1.6-0.6h43.4c0.9-6.4 0.8-13.9-1.4-23.2c-3.7-16.4-20.5-28.5-37.8-28.5z",
  "spider-web":"m20.4 18.5l57.1 72.1C74.9 139.2 53.8 176.4 25.2 210.6l-6.7-1.8v19.3l2.6 0.7c15.3 45.1 9.1 90.8 1.8 138.3l-4.4 2v20.6l9.2-4.3c6.5 10.7 13.7 27 19.1 41.3a554 554 0 0 1 9.3 26.5l-37.5 37.7v2.4h23.9l28.6-28.7c9.3-0.4 41.8-1.5 82.7-0.8c46.7 0.8 102.6 4.3 139.1 13.7l5.1 15.8h19.6l-7.4-23.1c35.9-41.5 71.9-80.5 131.7-102.3l51.8 20.5v-20.1l-43-17c-6.4-39.2 12.8-76.7 30.6-116.7l12.4-2.6v-19.1l-6.3 1.3l-5.5-2.8c-56.1-28.8-76.3-78-93.3-132.7l44.2-60.4h-23.1l-38.6 52.8c-58.3 1.3-112.5-2.5-154.4-37.8l-2.3-15h-18.9l2.8 18.8C171 66.2 140.5 85.2 93.5 80.6l-49.2-62.1H20.4zm199.9 41c40.6 26.3 88.5 30.9 136.8 30.6l-33.1 45.3c-36.6 0.4-69.9-3-95.8-24.6l-7.8-51.3zm-18.8 0.4l8.3 54.8c-17.8 18.6-37.3 30.2-68 26.9L108.8 99.8c38.6-0.7 68.4-17.1 92.8-39.9zM374.9 97.5c15.5 47 37 92.7 84.5 122.7l-51.8 10.8l-0.8-0.4c-37.3-19.1-50.4-51.6-61.9-88.8l-0.7-2.3l30.7-42zm-280.7 13.9l34.4 43.4c-2.5 29.6-15.4 52.7-33.1 74.2L45 215.8c23.7-29.8 42.6-63.4 49.2-104.4zm137.8 24.7c23.9 13.7 51 17.4 78.4 17.9l-32.9 45c-15.1-6.4-26.1-17.8-38.6-30.3l-2.3-2.4l-4.6-30.3zm-18.8 0.8l5.6 37c-11.2 7.5-24.4 12.2-39 15.5l-22.9-28.9c22.7-1.4 41.1-10.7 56.4-23.6m117.4 21.2c9.7 29.2 23.1 58 50.6 78.5l-55.9 11.7c-13-11.2-20-24.7-27.2-39.9l-1.7-3.5zm-186.4 16.4l19.1 24.2l-0.1 0.7c-1.9 17.4-8.9 29.6-16.6 43.1l-31.5-8.3c13.2-17.4 23.9-36.8 29.1-59.6zm77.7 19.4l6 39.7a39.2 39.2 0 0 0-10.2 3.5l-25.2-31.8c10.2-2.8 20.1-6.3 29.4-11.5zm19.4 3c7.4 6.6 15.5 12.7 25.2 17.4l-15.8 21.7a39 39 0 0 0-3.6-1.3l-5.7-37.7zm-62.8 20.9l24.9 31.4a39.6 39.6 0 0 0-4.1 7.1l-33.9-8.9c5-8.8 9.8-18.3 13.1-29.6m105.5 4.1c5.1 10.4 11.1 21.1 19.7 30.9l-31.1 6.5a39.5 39.5 0 0 0-6.9-12.2zM42.2 234.4l48.9 12.8c9.2 28.2 5.8 57.1 1.2 87.4L43.2 357.6c6-40.1 10.3-81.4-1-123.2zm416.1 5.2c-14.9 32.6-30.1 66.7-27.4 104.1l-43.7-17.3c-3.6-25 8.8-49.4 20.7-76.3l50.5-10.5zm-346.6 13.1l27.6 7.2l0.6 1.4c6.1 15.1 5.4 31.8 2.9 49.7l-30.3 14.2c3.2-23.5 5-47.8-0.8-72.5zm273.3 2.2c-9 19.8-17.8 40.8-17.3 63.8l-36.6-14.5c0-13.1 1.4-22.8 9.1-33.9l5-7.1zm-224.4 10.6l35.2 9.3a39.3 39.3 0 0 0 2.1 10.4l-35.3 16.5c1.1-11.9 0.9-24-2-36.2zm159.2 3c-4.6 9.4-6.4 18.9-6.9 28.5l-39.3-15.5c0.3-1.1 0.5-2.3 0.6-3.4l45.6-9.5zm-54.8 29.7l36.5 14.4c-8.9 4.6-17.3 10.5-24.7 16.2a263 263 0 0 0-9.9 7.9l-10.1-31.4c3-2 5.8-4.4 8.2-7.1zm-58.1 3.5L169.3 339.5c-2.6-6.2-6-11.1-9.6-15.2l0.1-0.6l47.2-22.1zm17.7 8.7a39.5 39.5 0 0 0 14.6 1.3l10.5 32.5c-13.3-0.2-37.6 0.1-61.7 3l36.6-36.8zm103.5 12.8l25.4 10c-29.4 14.9-50.4 35.9-69.3 57.2L273.2 356.1c3.6-3.2 8.7-7.6 15-12.4c11.4-8.7 26.2-17.7 35.7-19.6zM141.6 332.2l1.5 1.5c5.8 5.9 10 10.3 11.2 20.8l-31.1 31.3c-0.3-2.3-0.7-4.6-1.2-7.1c-2-10.9-4.4-22.9-9.3-32.9l28.9-13.5zm235.9 10.5l39.2 15.5c-49.4 22.5-82.9 56.7-113.5 91.5l-12.4-38.6c24.1-27.8 47.7-53.6 86.7-68.3zM95.6 353.8c3 6.8 6.2 18.2 8.1 28.3c1.6 8.6 2.5 16.1 3 20.4l-35.9 36.1a526 526 0 0 0-6.5-18.3c-5.4-14.2-12-30-19.6-42.6zm150.9 9.1c4 0 6.8 0 9.3 0.1l10.4 32.3c-26.3-4.2-58.6-4.2-87.1-3.2c-15.6 0.6-28 1.3-37.9 2.1l24.1-24.2l0.9-0.2c23.7-5.8 59.9-6.7 80.1-6.8m-42.2 47.4c24.9-0.1 50.4 1.3 68.4 5.1l13.4 41.7c-38.7-8.2-89-11-132.1-11.7c-27.2-0.5-49.2-0.2-63.9 0.2l30.8-31c7.8-0.8 30.7-2.8 58.9-3.8c7.9-0.3 16.1-0.5 24.5-0.5z",
  "spiked-dragon-head":"M188.8 20.4c-5.3 26.9 4.6 55.7 34.1 86.5c11.2-7.3 31.6-10.9 50-8.2c-46-22.3-66.5-47.1-84.1-78.4M29.2 26.6C43.6 73.1 81.1 128.8 129.6 168.3C93.5 166 49.9 153.1 18.8 143c25 35.2 64.2 52.9 103.3 66.3C97.1 227 67 245 18.7 248c54.6 19.2 107.5 8.9 131.3 0.7c-17.9 34.9-100.7 66.2-122.3 77c53.3 4.2 121.7-11 167-32.9c10 24.6-1.6 53.2-10.1 77.8c-1.9 4.5-3.8 8.9-5.7 13.3c5.1-3.5 10.1-7 14.9-10.6c23.6-16.2 47.8-31.9 59.5-58.8c26.1 31.2 62.7 62.1 107 85.4c17.4 22.1 28.3 49 34.2 73.8c8.3-19.1 13.8-40.2 9.7-60.3c24.5-3.6 35.6-29.7 35.5-54.4c-12.6 6.2-15.1 6.3-31.2 8.2c0-10.1 0.6-12.5-3-28.7c-10.3 8.4-21 11.2-30.8 11.8c2.1-7.6 3-19.5 3.7-27.3c-13 7.1-19.2 9.7-30.1 10.8c-0.4-10.9-0.1-20-4.1-30.4c-29.6 19-48.6 1.5-68-21.3c19.8-17 96.4-21.8 95.1 7.1c14-7.3 18.8-11.2 23.6-15.9c9.1 8.5 13.4 20.9 15.1 31.4c9.3-9.4 10.3-10.5 17.1-23.8c5.7 10.1 8.8 17 10.7 30.6c8.5-6.2 15.4-13.1 19.8-21.4c7.5 15.5 8.3 16 12.4 33c17.8-13.1 21.8-31.2 22.8-47.6c2-33-0.3-108.2-31-142.9c1.7 36.3-13.1 70-33.8 80.7c-12.6 4.9-96.5-74.6-137.6-93.3c-23.5-10.2-48.1 7.1-67.8 9.3C147 106.2 83.6 70.9 29.2 26.6M296.1 152.8c13.3 20.9 32.2 36.9 60.1 55c-19.4 2.9-65.8-6.7-77.7-24c-5.5-7.9 7.1-21.3 17.6-31M180.6 319.1c-14.4 6.2-29.2 10.9-43.8 14.3c-2.4 3.6-4.6 7.1-6.7 10.5c14.8 5.3 31.5 7 44.1 2.8c3.3-9.8 5.5-19.3 6.4-27.6m-68 19.1l-10.2 1.5c-31.8 36.6-61.9 103.2-48.2 151.9h36.1c-11.1-37.7-16.5-87.1 22.3-153.4m8.5 21.5c-5.9 11.4-10.4 22.1-13.8 32.1c12.9 6.7 29.1 8.9 44.8 8.2c4.6-10.5 9.8-21.8 14.6-33.3c-15.4 1.8-31.4-1.4-45.6-7m111.4 6.6c-12 10.5-25.2 20.3-38.9 29.6c7 34 33.4 63.4 73.9 95.7h83.3c-57.2-31.8-94.6-73.3-118.3-125.3m-130 43.2c-2.5 11.8-3.3 22.7-3 32.9c37.3 14.2 62.5 13.5 97.5 4.1c-7.2-10.3-13-21-16.9-32.3c-32.7 9.4-55.4 5.7-77.6-4.7m106.6 52.4c-38.1 10.9-68.8 13.2-107.5 0.3c1.8 10.4 4.5 20.1 7.5 29.4h130.1c-11.3-9.8-21.4-19.6-30.1-29.7",
  "sport-medal":"M338.8 31.8c-5 19.5-9.9 38.7-14.9 57.6c-45.3 7.3-90.5 7.3-135.8 0c-5-18.9-9.9-38.1-14.9-57.6c54.9 22.6 110.7 22.6 165.6 0m17.3 4.6l34.4 46c-14 96.2-40 204.2-77.5 302.9c-10.7-12.4-25.2-21.3-41.8-24.7c28.3-111.3 56.6-212.3 84.9-324.2m-200.2 0c28.3 111.9 56.6 212.9 84.9 324.2c-16.6 3.4-31.1 12.3-41.8 24.7c-37.5-98.8-63.5-206.7-77.5-302.9zM256 377c31.6 0 57 25.4 57 57s-25.4 57-57 57s-57-25.4-57-57s25.4-57 57-57",
  "spotted-bug":"m437.5 294.1l-46.3 2.7a134.1 134.1 0 0 0-20-93.2l31.3-40.4l-12.3-50.6l-16.8 4.1l10.4 42.5l-23.3 30.1A134.3 134.3 0 0 0 302.2 149.9l13.3-62.8l-18.1-66.2l-16.7 4.6l17 62.2l-12.3 57.7a132.7 132.7 0 0 0-29.5-2.6a27.5 27.5 0 0 0-27.1-30.3a49 49 0 0 0-30.8-22.9a28.9 28.9 0 0 1 5 12.1a29.3 29.3 0 0 1-57.8 10a48.3 48.3 0 0 0-6.8 32.6a49 49 0 0 0 1.3 6A27.5 27.5 0 0 0 153 195a134.5 134.5 0 0 0-17.8 31l-45.1-7.4l-51.2-57.4L26 172.8l55.2 62l48.4 7.9a133.1 133.1 0 0 0-0.5 65.5q1.3 5.4 3 10.5l-28.9 3.1l-48.6-38.2l-10.7 13.6l54.1 42.5l40.8-4.4a133.3 133.3 0 0 0 46.4 52.8l-16.4 50.7l-3.9 51.1l17.3 1.3l3.8-49l14.7-45.3a133.7 133.7 0 0 0 186.6-82.5l46.6-2.7l44.3 22.6l7.8-15.4zm-152.3-104c8.6-12.7 27.2-15.1 41.3-5.4s18.6 27.8 9.9 40.4c-8.7 12.7-27.2 15.1-41.3 5.4c-14.1-9.7-18.6-27.8-9.9-40.4zm-77.3-2.5c12.7-8.2 28.8-5.8 35.9 5.3s2.6 26.7-10.1 34.9c-12.7 8.2-28.8 5.8-35.9-5.3c-7.1-11.1-2.6-26.7 10.1-34.9m-5.8 179.2c-4 4.9-12.4 4.7-18.8-0.4c-6.4-5.2-8.4-13.4-4.4-18.3s12.4-4.7 18.8 0.4s8.4 13.4 4.4 18.3m-0.9-42.2c-16.2 3.9-32.7-7.2-37.1-25c-4.3-17.7 5.3-35.3 21.4-39.2c16.1-3.9 32.7 7.2 37.1 25c4.3 17.7-5.3 35.3-21.4 39.2zm42.8 54.3c-17.9-3.6-29.8-19.1-26.7-34.5c3.1-15.4 20.2-25 38.1-21.3s29.8 19.1 26.7 34.5c-3.1 15.4-20.2 25-38.1 21.3zm54.6 16.2c-8.1 1.7-15.7-1.7-16.9-7.7s4.2-12.2 12.3-13.9c8.1-1.7 15.7 1.7 16.9 7.7s-4.2 12.2-12.3 14zm59.8-69.2c-9.7 14.1-27.8 18.5-40.4 9.8c-12.6-8.7-15-27.2-5.3-41.3s27.8-18.5 40.4-9.8c12.6 8.7 15 27.2 5.3 41.3m6.1-55.8c-6.1 0.7-11.8-5.3-12.8-13.5s3.1-15.4 9.2-16.2s11.8 5.3 12.8 13.5c1 8.2-3.1 15.4-9.2 16.2z",
  "star-medal":"M41 27.7v46h430v-46zm32 64v112.5l62 20.7V91.7zm80 0v139.2l79.3 26.4c-10.4 7.5-17.3 19.7-17.3 33.4c0 21 16.1 38.5 36.5 40.7l-22.3 43.7l-58.2 9.3l41.6 41.7l-9.1 58.2l52.5-26.7l52.5 26.7l-9.1-58.2l41.6-41.7l-58.2-9.3l-22.3-43.7c20.4-2.2 36.5-19.7 36.5-40.7c0-13.7-6.9-25.9-17.3-33.4l79.3-26.4V91.7h-94v159c-2.9-0.6-5.9-1-9-1s-6.1 0.4-9 1v-159zm224 0v133.2l62-20.7V91.7zm-121 176c12.8 0 23 10.2 23 23s-10.2 23-23 23s-23-10.2-23-23s10.2-23 23-23",
  "sun":"M320.1 19.7c-72.3 14.6-19.2 71.7-74.3 108.8c4.8-0.5 9.7-0.7 14.7-0.6c16.3 0.3 32.8 3.7 48.6 10.7a126 126 0 0 1 14.2 7.4c12.1-47.5-37.1-96.4-3.2-126.3zM136.8 44.5c-40.8 61.4 37 64.3 24.4 129.4c17.4-21.3 41.2-35.9 67.2-42.3c-25-42.1-94.4-41.9-91.6-87.1zm297.3 75.4c-32.5 0.9-45.5 46.3-96.6 36.2c21.4 17.4 36 41.2 42.5 67.3c42.3-24.9 42.1-94.5 87.3-91.6c-13.4-8.9-24.1-12.2-33.2-11.9zm-178 26.7c-23.7 0.5-46.5 8.8-64.9 23.6l18.7 36.2L170 193.2a107.6 107.6 0 0 0-9.4 16.9c-8.7 19.7-11 40.6-7.8 60.3l44.8 2.1l-34 30.3c10.8 20.6 28.4 37.9 51.4 48a108 108 0 0 0 9.3 3.6l24.5-38.2l9.1 43.8c27.3 0.1 53.7-10.4 73.6-29.2l-19.2-37.1l38.4 12.7a109 109 0 0 0 5-9.9c9.7-22 11.5-45.5 6.4-67.2l-37.6-1.8l27.7-24.7c-10.8-20.2-28.2-37.1-50.9-47.1a107 107 0 0 0-4.1-1.7l-25.9 40.3l-9.9-47.8c-0.5 0-1 0-1.5 0c-1.3 0-2.6 0-3.9 0zM133.4 186.5c-41.7 0.7-82.5 34.8-108.7 5.1c14.6 72.2 71.7 19.3 108.8 74.3c-2.2-21 0.9-42.8 10.1-63.4a126 126 0 0 1 7.3-14.1c-5.8-1.5-11.6-2-17.5-1.9zm249.5 54a124.7 124.7 0 0 1-10 63.6l-0.2 0.4a126 126 0 0 1-7.2 13.8c47.5 12.2 96.5-37.1 126.5-3.2c-14.6-72.4-71.9-19-109-74.6zM136.5 283.4c-42.1 25-41.9 94.4-87.1 91.5c61.4 40.8 64.3-37.1 129.6-24.3c-21.3-17.4-36-41.2-42.5-67.2zm219.1 48.9c-17.4 21.5-41.2 36.2-67.3 42.7c24.9 42.3 94.5 42 91.7 87.2c40.9-61.5-37.4-64.4-24.3-129.9M193.4 360.7c-12 47.5 37.1 96.3 3.2 126.2c72.3-14.6 19.2-71.8 74.5-108.9c-21 2.2-42.9-0.9-63.6-10.1a126 126 0 0 1-14-7.3",
  "sunbeams":"M17.5 17.9V27.1l31.7 13.2c-4.9 16.7-7.9 34.2-8.5 52.3L17.5 89.4v63.4l28.9-3.9a208 208 0 0 0 17.5 47.1l-46.4 19.2v85.7l77.3-60.3a211.3 211.3 0 0 0 36.2 31.8L17.5 419v74.8h79.2l80.5-197.3a208 208 0 0 0 45.7 11.3l-24.9 186H299.9L275.1 308.2a208 208 0 0 0 46.3-10.9l80 196.6h92.2v-58.5L368 273.3a211.3 211.3 0 0 0 35.7-30.7l89.7 69.1V221.2l-57.6-23.7a208.2 208.2 0 0 0 17.9-47.1l39.7 5.3v-68.3l-33.7 4.5a209.2 209.2 0 0 0-8.7-52.1l42.4-17.5v-4.3h-112.2l-42.3 32.5c-4.7-8.1-10.2-15.1-16.8-21.7l8.1-10.8H167.7l7.6 9.8c-6.9 6.7-12.5 14.3-17.3 22.8l-41.7-32.5zm416.2 29c4.4 15.1 6.9 31 7.4 47.4l-88.6 11.9c0-1.2 0-2.1 0-3.3c0-7.2-0.8-14.9-2.2-21.7zM66.6 47.5l78.9 32.7c-1.5 7.1-2.2 15.2-2.2 22.8c0 1.2 0 2.1 0 3.3L59.3 95a190.5 190.5 0 0 1 7.3-47.5zm82.7 87.5c2.5 7.6 5.7 15 9.8 21.7l-77.8 32.2a189.5 189.5 0 0 1-16.2-42.4l84.3-11.4zm197.9 1.1l88.1 11.7a189.8 189.8 0 0 1-16.6 42.5l-81.7-33.7c3.9-6.4 7.8-13.4 10.3-20.6zm-171.9 41.7c5.6 5.4 11.2 10 17.9 14.1l-50.8 65.7a191.8 191.8 0 0 1-32.8-28.5l65.8-51.3zm144.2 0l69.5 53.5a191.7 191.7 0 0 1-32.3 27.3l-52.9-68.3c5.7-3.6 10.8-7.8 15.7-12.5zm-37.4 22.8l32.3 79.4a190 190 0 0 1-41.7 9.7L261.4 206.5c7-0.9 14.1-3.7 20.6-6zm-66.1 1.1c6.5 2.1 13.6 4.1 20.6 4.9l-11.1 82.8a189.8 189.8 0 0 1-41.2-10.1z",
  "sunrise":"M259.4 16.2c-132.3 0-239.8 107.5-239.8 239.8s107.5 239.8 239.8 239.8s239.8-107.5 239.8-239.8s-107.5-239.8-239.8-239.8zm33.5 20.4c26.6 4 51.6 12.7 74.2 25.2L308.9 209c-14.6-7.2-31-11.3-48.3-11.5zm-67.7 0.1l24 161.2c-17.2 1.6-33.3 7-47.3 15.4l-51-151a220.4 220.4 0 0 1 74.3-25.7zm193.2 64.5c17.7 18.2 32.3 39.3 42.9 62.7l-107.7 85.5a111.7 111.7 0 0 0-35-34.9l99.7-113.3zm-319.1 1.1L192.5 219.7a111.7 111.7 0 0 0-32.1 37.8L56.5 166c10.5-23.7 25.1-45.2 42.8-63.7zm378.8 115.9a224 224 0 0 1 3.2 37.8c0 11.5-0.9 22.8-2.6 33.8l-107.9 16.1a111.2 111.2 0 0 0-12-47.4l119.2-40.3zM40.2 221.1l115.8 45.8a111.3 111.3 0 0 0-8.2 39l-107.8-16A224 224 0 0 1 37.5 256c0-11.9 1-23.6 2.8-34.9zm130.6 89.5h177.1L467 334.5c-31.7 83.8-112.6 143.4-207.6 143.4c-95 0-176-59.5-207.6-143.4l119.1-23.9z",
  "take-my-money":"M225.8 32.3q-5.9 0-11.9 0c-19.1 0.1-38.6 0.6-58.2 1.3l5.7 24.9c20.4-2.3 42.8-4 65.2-4.9c12.1-0.5 24.2-0.7 35.9-0.7c35.1 0.2 66.9 3.1 87.8 11.2l8.9 3.5l-4 8.7c-29.1 63.5-35.8 124.7-31.2 184.8c2.2-71.3 31.9-134.8 70.8-216.1c-53-8.8-109.6-12.6-169-12.8zm28 38.8c-8.7 0-17.6 0.2-26.6 0.5c-41.7 1.6-83.2 6.5-110.3 12.1c30.2 56.1 54.7 112.3 70.5 167.1a72 72 0 0 1 5.9 0c4 0.2 8 0.7 11.9 1.6c-16.1-51.4-34.4-98.8-57.1-146.1l-5.1-10.7l11.7-2.1c29.4-5.2 59.7-7.2 88.5-7.2q2.9 0 5.7 0c18.3 0.2 36 1.1 52.3 2.5l11.1 1l-3.2 10.6c-18.7 61.6-22.4 127.7-11.8 190.6q0.3 0.2 0.5 0.5c3.8-1.3 7.4-2.7 10.7-4.2c-8.3-67.4-4.6-136.9 26.2-209.2c-17.2-4.4-43.4-6.7-72.2-7a657 657 0 0 0-8.7-0.1zm144.9 7.4c-31 65.6-52.9 118.1-56.5 174.8c20-66.8 58.8-126.7 102.9-165.2a602 602 0 0 0-46.4-9.6M103.8 97c-18.8 3.9-37.1 8.8-54.8 15.6c8.6 7.5 24.2 21.4 43.1 39.9c8.7-9 17.6-17.8 26.9-25.9a1068 1068 0 0 0-15.2-29.6m142 7.5c-13.6-0.1-27.6 0.3-41.6 1.3c-1.5 13.7-9.6 26.5-19.2 39.1c15.4 36.5 28.8 73.7 40.8 113.2c18.4 5.4 36.6 11.8 51.3 19.5c-5.5-42.5-4.7-86 2.4-128.5q-19.3-20-20.1-44.3a622 622 0 0 0-13.5-0.2m182 27c-24.7 29.3-46.5 66-61.4 105.9c27.3-38.8 60.8-69 96.5-90.4a1319 1319 0 0 0-35.1-15.5m-300.7 12c-14.6 13.2-29 29-44 44.1c32.3 19.2 59.8 41.9 82.2 67.7c1.4-0.5 2.8-1 4.2-1.4c-10.5-36.1-24.9-73-42.4-110.3M360.5 268.2c-16.4 19.8-31.8 30.2-53.1 38.6c2.4 9.2-1.2 19.8-9.3 27.9c-4.8 4.8-10.8 10.2-19.7 13.7a63 63 0 0 0 3.9 2.1c12.4 6.2 34.2 4.2 54.5-5c20.2-9.2 38.3-25.1 45-41.2c3.4-9.1 1-13.8-4.9-20.7c-4.2-4.9-10.3-9.9-16.4-15.4zm-170.1 0.6c-10.7-0.1-21.6 3-30.6 9.8c-12.8 9.6-22.6 26.8-22.7 55.9v0.2l0 0.2c-2.9 61.4 1.6 89.7 10.6 105.1c7.9 13.6 21.1 20.1 40.3 32c0.9-2.4 1.9-5.4 2.8-9.1c2.3-9.5 4.2-22.5 5.4-37c2.4-28.9 2-63.5-2-88.4l-2.1-13.2l13 3c31.6 7.3 49.7 8.1 60.2 6.3c10.5-1.9 14.1-5.5 20.2-11.6c5.8-5.7 5.7-7.8 4.5-11c-1.2-3.2-6.1-8.5-14.5-13.6c-16.7-10.2-45.1-19.6-71.6-26.6a54 54 0 0 0-13.3-1.8m189.1 69.4c-10 9.8-22.3 17.8-35.3 23.6c-21 9.5-44.1 13.9-63.2 7.6c-6.8 2.5-10.7 5.4-12.7 7.8c-2.7 3.3-2.9 5.7-2 9.2s3.7 7.6 7.1 10.5c3.4 3 7.4 4.5 9 4.6c46.8 2.2 67-11.2 92.3-26.8c7.4-4.5 10.2-13.7 9.5-22.9c-0.4-4.6-1.7-8.9-3.2-11.6a9 9 0 0 0-1.4-1.9m-166.2 9.1c2.7 25.1 2.8 54.3 0.6 80.1c-1.2 15.1-3.2 28.8-5.8 39.7c-1.1 4.7-2.4 9-3.9 12.7l146.7-6.5c-1.7-6.1-3.3-12.3-5-18.5a127 127 0 0 1-17.2 4.4l0 0.7l-8.3 0.5c-5.1 0.6-10.5 1-16 1l-83.9 5.2l2.5-11.6c7.9-37 8.7-69.6 3.8-105.2a353 353 0 0 1-13.5-2.5zm32 4.7c3.9 31.9 3.5 62.4-2.4 95.2l19.3-1.2a39.4 39.4 0 0 1-6.1-14.8c-1.3-6.9-0.6-14.5 3.9-20.9c0.2-0.3 0.4-0.6 0.6-0.8c-5.2-4.8-9.6-11.1-11.6-18.5c-2.1-7.9-0.8-17.7 5.5-25.3c2.1-2.5 4.6-4.8 7.5-6.8c-2.6-2.1-4.9-4.3-6.9-6.6c-3.1 0-6.3-0.1-9.9-0.3m132.7 41.8c-23.5 14.3-49.8 27.9-96.4 25.7a26.4 26.4 0 0 1-4.5-0.6c-1.2 0.6-1.9 1.3-2.4 1.9c-1 1.4-1.5 3.8-0.9 7.1c1.2 6.6 7.5 13.9 13.4 14.6c41.4 4.8 70-8.7 87.3-24.5c8-7.3 8.1-11.9 6.9-17c-0.6-2.5-1.9-5-3.4-7.2m-6.7 49.1a115 115 0 0 1-8.5 4.9c1.6 6.1 3.3 12.1 4.9 18.2l19.9-3.6c-5.1-4.4-9.2-9-12.4-13.5c-1.4-2-2.7-4-3.9-5.9",
  "target-arrows":"M27.5 25.7C37 62.8 51.9 100.2 69.1 137.9c17.5-31.6 41.2-53 71.6-70.5C102.8 50.6 65.1 36.3 27.5 25.7m456.2 0c-37.6 10.6-75.3 24.9-113.2 41.7c30.4 17.5 54.1 38.9 71.6 70.5c17.1-37.6 32.1-75.1 41.6-112.2zm-367.1 81.3a146 146 0 0 0-10.2 10.1L232.1 242.8l10.3-10.2zm278 0L28 473.1l10.5 10.3L404.8 117.1a145 145 0 0 0-10.2-10.1zm-139 26.8c-24.3 0-47 7.2-66 19.7l13.5 13.5c15.3-9.2 33.3-14.5 52.5-14.5c19.2 0 37.2 5.3 52.5 14.5l13.5-13.5c-19-12.4-41.6-19.7-66-19.7zm0 45.1a75.1 75.1 0 0 0-33 7.6l14.2 14.2a57.2 57.2 0 0 1 18.7-3.1c6.6 0 12.8 1.1 18.7 3.1l14.2-14.2a75.1 75.1 0 0 0-33-7.6zm102.3 11.6l-13.6 13.6c8.5 14.9 13.3 32.1 13.3 50.5c0 19.2-5.3 37.1-14.4 52.4l13.5 13.5c12.4-19 19.6-41.6 19.6-65.9c0-23.5-6.8-45.5-18.4-64zm-204.6 0c-11.7 18.6-18.4 40.5-18.4 64c0 24.3 7.2 46.9 19.6 65.9l13.5-13.5c-9.2-15.3-14.4-33.2-14.4-52.4c0-18.4 4.8-35.6 13.3-50.5zm171.3 33.2l-14.5 14.5a57.3 57.3 0 0 1 2.4 16.3a57.2 57.2 0 0 1-3.1 18.7l14.2 14.2a75.1 75.1 0 0 0 7.5-32.9c0-11-2.4-21.4-6.6-30.8zm-138.1 0a75 75 0 0 0-6.6 30.8a75.1 75.1 0 0 0 7.5 32.9l14.2-14.2a57.2 57.2 0 0 1-3.1-18.6c0-5.7 0.8-11.2 2.4-16.3l-14.5-14.5zm92.5 45.5l-10.3 10.3l203.8 203.8l10.5-10.3zm-39.8 39.8l-14.5 14.5a75.1 75.1 0 0 0 30.8 6.6a75 75 0 0 0 30.8-6.6l-14.5-14.5a57.3 57.3 0 0 1-16.3 2.4a57.3 57.3 0 0 1-16.4-2.4zM81.9 341.3l-68 68h51.6l68.1-68H81.9zm295.8 0l68.1 68h51.6L429.3 341.3zm-172.5 1.9l-13.6 13.6c18.6 11.7 40.5 18.4 64.1 18.4c23.5 0 45.5-6.8 64-18.4l-13.6-13.6c-14.9 8.5-32.1 13.3-50.5 13.3c-18.4 0-35.6-4.8-50.5-13.3zm-34.9 34.9l-68 68l0 51.5l68-68v-51.5zm170.8 0v51.5L409 497.7l0-51.5l-68-68z",
  "target-prize":"M256 25c-25 0-47.7 2-63.6 5.2c-6.2 1.2-11 2.6-14.7 4c3.7 1.4 8.5 2.8 14.7 4c15.9 3.1 38.6 5.2 63.6 5.2s47.7-2 63.6-5.2c6.2-1.2 11-2.6 14.7-4c-3.7-1.4-8.5-2.8-14.7-4c-15.9-3.1-38.6-5.2-63.6-5.2M155.2 30.3c-19.1 8.9-29.4 26-26.8 43.1c2 12.3 10.9 23.5 25 29.3c8.1 3.4 17.9 5.2 29.4 5.1c13.3 24.7 31.3 45.1 50.6 54.6v43.9c-17 10.3-28.3 31.7-39.4 53.7c38.8 9.9 85.3 9.4 123.9-0.1c-11-22-22.4-43.3-39.3-53.6v-43.9c19.3-9.5 37.3-29.9 50.6-54.6c11.5 0.1 21.3-1.7 29.4-5.1c14.1-5.8 23-17 25-29.3c2.6-17.1-7.7-34.2-26.8-43.1c0.4 1.2 0.6 2.5 0.6 3.9c0 4.3-2.3 7.9-4.7 10.2c-2.3 2.2-4.9 3.7-7.8 5.1c-5.8 2.7-13.1 4.7-21.9 6.4c-17.5 3.5-41 5.5-67 5.5s-49.5-2-67-5.5c-8.8-1.7-16.1-3.7-21.9-6.4c-2.9-1.4-5.5-2.8-7.8-5.1c-2.4-2.2-4.7-5.8-4.7-10.2c0-1.4 0.2-2.6 0.6-3.9m6.6 16.3c2.3 14.3 6.5 28.9 12.3 42.7c-5.6-0.6-10.1-1.7-13.8-3.2c-9.4-3.9-13.2-9.6-14.1-15.5c-1.2-7.9 3.3-18.1 15.6-24m188.4 0c12.3 5.8 16.8 16.1 15.6 24c-0.9 5.9-4.7 11.6-14.1 15.5c-3.7 1.5-8.2 2.7-13.8 3.2c5.8-13.8 10-28.4 12.3-42.7M256 278L96 358L224 342l-32 144h128l-32-144l128 16z",
  "thor-hammer":"m266 32.4l-85.2 85.2v19.8L285.8 32.4zm41.5 3.7L184.5 159.2l168.3 168.3L475.9 204.4L307.6 36.1zm172 190L374.5 331.2h19.8l85.2-85.2v-19.8zm-239.9 13.6l-9.9 9.9l32.5 32.5l9.9-9.9zm-22.6 22.6l-23.5 23.5h47.1zm-41.5 41.5l-27.3 27.3h65.1l27.3-27.3zm-45.3 45.3l-27.3 27.3h65.1l27.3-27.3zm-27.3 45.3l23.5 23.5l23.5-23.5zm-21.7 3.7l-9.9 9.9l32.5 32.5l9.9-9.9l-32.5-32.5zm-38.8 18.9l-7.5 22.5l37.4 37.4l22.5-7.5v-12.4L54.9 417.1z",
  "tied-scroll":"M373.6 18.4c-15.6-0.2-27.9 4.6-32.6 14.8c-22.8 49.6-48.7 87.1-79.1 117.3a63 63 0 0 1 8.9 3.8c13 6.7 25.3 17.8 35.3 30.8s17.9 28.1 20.8 43.5c0.7 3.9 1.2 7.9 1.2 11.8c39-24.4 85.1-41.2 140.9-51.3c14.9-2.7 23.7-28.6 21.4-58.7l-35.2-1l30.6-24.8c-4.1-14.5-11-28.8-21.2-40.7c-15.5-18.3-36.4-31.4-56.7-38.7L381.9 40.8l2.8-21.5c-3.9-0.6-7.6-0.9-11.2-0.9zM246.9 166.6c-1.1 0.1-2.1 0.2-3 0.5c-12 10.3-24.6 19.6-37.9 28.3c0.8 0.3 1.7 0.7 2.5 1c14.1 6.2 27.4 17.1 38.5 30.6c13.4 16.3 23.6 36.9 25.6 57.8c10.3-10.4 21.2-19.9 32.8-28.7c4.1-6.6 4.9-14.5 3.1-23.9c-2.2-11.5-8.6-24.4-17.2-35.6c-8.6-11.2-19.4-20.6-29.1-25.6c-6.1-3.1-11.2-4.5-15.3-4.2zm-61.9 43.3c-1.4 0.1-2.7 0.3-4 0.6c-37 20.8-79.1 38-127.3 56c0.6 0 1.1 0.1 1.7 0.2c10.6 1.2 21.1 5 31.2 10.9L124.3 261L108.5 293.7c6 5.4 11.8 11.5 17.3 18c20.8 24.4 38 55.9 47.1 88.1c0 0 0 0 0 0c3 10.5 5.1 20.9 6.3 31c21-48.4 44.4-89.3 72.3-123c7.3-21.5-2.2-48.4-19.1-69c-9.4-11.5-21-20.7-31.5-25.3c-5.9-2.6-11.3-3.8-16-3.6zm141.6 54.8c-7.3 5-14.5 10.5-21.4 16.3c39.2 9.3 61 35.7 80.7 62.2c10.5 14 20.6 28.1 33.1 40.7c24.2 9.1 43.2 6.4 63.9-14.9c-92.2-27.8-96.1-92.6-156.2-104.2zM48.6 284.9c-10.9 0.2-18.3 5.8-23.3 16.6c-5.8 12.4-7.1 32.5 0.4 57.1c5.8 18.7 16.5 37.7 28.8 51.6s25.9 22.1 35.4 22.4h0c3.7 0.1 6.6-0.7 8.8-2.8l-0.2-0.2l2.1-2.1c0.8-1.2 1.5-2.5 2.2-4.2c2.8-6.9 3.3-18.6-1.8-33c-6.9-19.4-19.1-31.9-33.4-34.8l-23-4.6l19.8-12.5l38.5-24.2c-16.6-16.8-34.5-27.6-49.4-29.2c-1.7-0.2-3.3-0.2-4.9-0.2zm236.2 5.4l-24.5 25.4c100.4 17.9 55.5 141 159.3 176.2l-24.8-57.3c32.8 16.1 67.4 22.6 97.7 12c-135.8-41.9-96.3-127-207.7-156.3m-169.5 38.2l-26 16.3c13.2 8.5 23.2 22.6 29.1 39.2c2.6 7.2 4.1 14.2 4.8 20.8l23.4-23.4c-8.1-19.2-19-37.6-31.3-53zm38.4 72.4l-42.1 42l-0.2-0.2c-4.3 3.9-9.5 6.8-15.2 7.9c23.3 14.9 44.6 19.3 56.8 9.6c4.3-3.4 7-8.4 8.5-14.4c-0.4-12.7-2.6-26.6-6.7-40.9c-0.4-1.3-0.8-2.7-1.2-4",
  "trophy-cup":"M98.4 21.1a17 17 0 0 0-4.6 0.5c-20.5 5.3-33.2 20.6-36.1 38.6c-3 18 2.2 38.3 12.7 58.2c20.7 39.1 63.3 77.1 117.9 85.8c-5.6-6.7-11.1-14.2-16.3-22.4c-39-12.6-70-42.3-85.7-71.9c-9.2-17.4-12.8-34.5-10.8-46.9C77.4 50.9 83.5 42.9 98.2 39.1c0.1 0 0.1 0 0.1-0.1c-0.1-0.1 0.1-0.1 0 0a0.7 0.7 0 0 0 0.2 0.2c0.5 0.5 1.7 2.2 2.2 5.1c1 5.8-0.4 15.6-8.1 25.7l14.3 10.9c10.4-13.6 13.7-28.1 11.6-39.8c-1-5.8-3.4-11.2-7.6-15.1c-3.2-3-7.7-4.9-12.4-5zm315.2 0c-4.7 0.1-9.2 2-12.4 5c-4.2 4-6.6 9.3-7.6 15.1c-2.1 11.7 1.1 26.2 11.6 39.8l14.3-10.9c-7.7-10.1-9.2-19.9-8.1-25.7c0.5-2.9 1.7-4.6 2.2-5.1a0.7 0.7 0 0 0 0.2-0.2c-0.1-0.1 0.1-0.1 0 0c0 0 0 0 0.1 0.1c14.8 3.8 20.8 11.8 22.8 24.1c2 12.4-1.6 29.5-10.8 46.9c-15.6 29.6-46.7 59.3-85.7 71.9c-5.2 8.1-10.7 15.7-16.3 22.4c54.6-8.8 97.2-46.8 117.9-85.8c10.5-19.8 15.6-40.2 12.7-58.2c-3-18-15.6-33.4-36.1-38.6a17 17 0 0 0-4.6-0.5m-276.2 7.7c2.1 36.5 16.8 83.1 36.5 120.8c10.7 20.4 22.9 38.3 34.8 50.7C220.6 212.7 232 218.9 240 218.9h32c8 0 19.4-6.1 31.3-18.5s24.1-30.2 34.8-50.7c19.8-37.8 34.4-84.3 36.5-120.8zm95.6 208v16h46v-16zm6.4 34c-2.5 26-12.8 57.9-24.4 76h82c-11.6-18.1-22-50-24.4-76zm-38.4 94v14h110v-14zm-32 32v94h174v-94zm23 23h128v48H192z",
  "two-coins":"M264.4 95c-35.6-0.1-80.2 11.2-124.2 34.1C96.3 152 61.5 182 41 211.3c-20.4 29.2-26 56.4-15.9 75.8c10.1 19.3 35.5 30.4 71.2 30.4c35.7 0.1 80.3-11.2 124.2-34c44-22.9 78.8-53 99.2-82.2c20.5-29.2 25.9-56.4 15.9-75.8c-10.1-19.3-35.5-30.5-71.2-30.5m91.9 70.3c-3.5 15.3-11.1 31-21.8 46.3c-22.6 32.3-59.5 63.8-105.7 87.8c-46.2 24.1-93.1 36.2-132.5 36.2c-18.6 0-35.8-2.8-50.4-8.7l10.6 20.4c10.1 19.4 35.5 30.5 71.2 30.5c35.7 0 80.3-11.2 124.2-34.1c44-22.8 78.8-52.9 99.2-82.2c20.4-29.2 26-56.4 15.9-75.7zm28.8 16.8c11.2 26.7 2.2 59.2-19.2 89.7c-18.9 27.1-47.8 53.4-83.6 75.4c11.1 1.2 22.7 1.8 34.5 1.8c49.5 0 94.3-10.6 125.9-27.1c31.7-16.5 49.1-38.1 49.1-59.9s-17.4-43.4-49.1-59.9c-16.1-8.4-35.7-15.3-57.6-20m106.7 124.8c-10.2 11.9-24.2 22.4-40.7 31c-35 18.2-82.2 29.1-134.3 29.1c-21.2 0-41.6-1.8-60.7-5.2c-23.2 11.7-46.5 20.4-68.9 26.1c1.2 0.7 2.4 1.3 3.7 2c31.6 16.5 76.4 27.1 125.9 27.1s94.3-10.6 125.9-27.1c31.7-16.5 49.1-38.1 49.1-59.9z",
  "warhammer":"m351.4 31.4l-55.9 27.8l54 34.6zM143.2 67.3l20 33.5L182 71.5zm57 9.2l-7.6 11.8l100.2 64.2l-9.7 15.1l-100.2-64.1l-24.8 38.7l100.2 64.1l-9.7 15.2l-100.2-64.1l-7.5 11.7l150 96.1l37.9-7.6l44.8-70zm93.2 2.7l-16.2 25.3l38.7 24.7l16.2-25.2zM108.7 121.2l20 33.5l18.8-29.3zm280.1 76.1L346.7 263l11.8 7.5l42.1-65.7zm-224.1 8.5l0.6 36l72.8 46.6l33-14.5zm250.4 9.9l-33.2 51.8c11.7 2.8 24 7.3 36.5 12.3c19.3 7.6 39.1 16.7 56.6 24c-9.5-27.2-22.2-57.9-59.9-88.1m-242.5 52.1L27.8 494h54.6L211.4 292.6z",
  "weight-crush":"M256 16c-41.4 0-75 33.6-75 75c0 17.1 5.9 32.4 15.5 45H136L46 346h420l-90-210h-60.5C325.1 123.4 331 108.1 331 91c0-41.4-33.6-75-75-75m0 30c24.9 0 45 20.1 45 45s-20.1 45-45 45s-45-20.1-45-45s20.1-45 45-45m-4.2 330A60 60 0 0 0 196 436a60 60 0 0 0 120 0a60 60 0 0 0-64.2-60",
  "weight-lifting-up":"m77.5 18.5l-17.7 3.1L69.1 74.5a1631 1631 0 0 0-15.8 2.5l-6.5-36.9l-17.7 3.1l6.5 36.8a1878 1878 0 0 0-17.2 3.1l3.3 17.7c5.7-1.1 11.4-2.1 17-3.1l7.1 40l17.7-3.1l-7-39.9q8-1.3 15.8-2.5l9.8 55.5l17.7-3.1l-9.7-55a1416 1416 0 0 1 25.2-3.4c15.5 46.4 34.7 100 66.9 134.4C190.9 251 192 268 214.6 310C192 348 176 412 167.2 471l-48 6v15H192c16-48 64-144 64-144s48 96 64 144h72.8v-15l-48-6C336 412 320 348 294 310c26-42 24.2-59.6 35.8-89.4c32.2-34.5 51.4-88.1 67-134.5c8.3 1 16.7 2.2 25.2 3.4l-9.7 55l17.7 3.1l9.8-55.5q7.8 1.2 15.8 2.5l-7 39.9l17.7 3.1l7.1-40c5.6 1 11.3 2 17 3.1l3.3-17.7c-5.8-1.1-11.5-2.1-17.2-3.1l6.5-36.8l-17.7-3.1l-6.5 36.9a1565 1565 0 0 0-15.8-2.5l9.3-52.9l-17.7-3.1l-9.4 53.4C366 63.3 311 59 256 59c-55 0-110 4.3-169.1 12.8zM256 77c35.5 0 71.1 1.8 107.8 5.5c-14.1 34.9-38.5 73.5-63.2 102C290.3 199.3 274.4 209 256 209s-34.3-9.7-44.6-24.6c-24.7-28.5-49.1-67.1-63.2-102c36.8-3.6 72.3-5.5 107.8-5.5M256 97c-20.8 0-39 20.2-39 47s18.2 47 39 47s39-20.2 39-47s-18.2-47-39-47"
};
var pixCache = {};
function pixPath(name){
  var g = PIX[name] || PIX.star, d = "";
  g.forEach(function(row, y){
    var x = 0;
    while(x < 8){
      if(row.charAt(x) !== "#"){ x++; continue; }
      var w = 1; while(x + w < 8 && row.charAt(x + w) === "#") w++;
      d += "M" + x + " " + y + "h" + w + "v1h-" + w + "z";
      x += w;
    }
  });
  return d;
}
function pixSvg(name){
  if(pixCache[name]) return pixCache[name];
  if(GI[name]) return (pixCache[name] = '<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path fill="currentColor" d="' + GI[name] + '"/></svg>');
  return (pixCache[name] = '<svg viewBox="0 0 8 8" aria-hidden="true" focusable="false" shape-rendering="crispEdges"><path fill="currentColor" d="' + pixPath(name) + '"/></svg>');
}
// --- medallions: a hexagon badge whose frame grows with rarity ---
// 1 common: one frame · 2 rare: a second, inner frame · 3 epic: a heavy frame with white
// corner studs · 4 legendary: spikes from every corner, a dashed ring, a white icon
var RARITY_NAME = ["", "common", "rare", "epic", "legendary", "mythic"];
function hexPts(r, turn){
  var pts = [];
  for(var i = 0; i < 6; i++){
    var a = Math.PI / 180 * (60 * i - 90 + (turn || 0));
    pts.push((50 + r * Math.cos(a)).toFixed(2) + "," + (50 + r * Math.sin(a)).toFixed(2));
  }
  return pts.join(" ");
}
var medalCache = {};
function medalSvg(icon, rarity, earned){
  var key = icon + "|" + rarity + "|" + (earned ? 1 : 0);
  if(medalCache[key]) return medalCache[key];
  var red = earned ? "#e5484b" : "#2f2f2f", hi = earned ? "#e7e7e7" : "#2a2a2a", plate = earned ? "#170d0e" : "#121212";
  var o = '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">';
  // mythic: twelve spikes, a white outer ring, and an inverted plate (solid red, dark icon)
  if(rarity >= 5){
    for(var q = 0; q < 12; q++){
      var qa = Math.PI / 180 * (30 * q - 90), len = q % 2 ? 45 : 52, sp = q % 2 ? .1 : .14;
      o += '<polygon fill="' + (q % 2 ? hi : red) + '" points="' + (50 + len * Math.cos(qa)).toFixed(2) + "," + (50 + len * Math.sin(qa)).toFixed(2) + " " +
        (50 + 36 * Math.cos(qa - sp)).toFixed(2) + "," + (50 + 36 * Math.sin(qa - sp)).toFixed(2) + " " + (50 + 36 * Math.cos(qa + sp)).toFixed(2) + "," + (50 + 36 * Math.sin(qa + sp)).toFixed(2) + '"/>';
    }
    o += '<polygon points="' + hexPts(46, 30) + '" fill="none" stroke="' + hi + '" stroke-width="1.2" stroke-dasharray="3 2"/>';
    o += '<polygon points="' + hexPts(41) + '" fill="' + (earned ? red : "#1a1a1a") + '" stroke="' + hi + '" stroke-width="4" stroke-linejoin="miter"/>';
    o += '<polygon points="' + hexPts(33) + '" fill="none" stroke="' + (earned ? "#0f0f0f" : "#2f2f2f") + '" stroke-width="1.5"/>';
    for(var m5 = 0; m5 < 6; m5++){
      var c5 = Math.PI / 180 * (60 * m5 - 90);
      o += '<rect x="' + (50 + 41 * Math.cos(c5) - 3.5).toFixed(2) + '" y="' + (50 + 41 * Math.sin(c5) - 3.5).toFixed(2) + '" width="7" height="7" fill="' + (earned ? "#0f0f0f" : "#2f2f2f") + '" stroke="' + hi + '" stroke-width="1.5"/>';
    }
    var ink5 = earned ? "#0f0f0f" : "#2f2f2f";
    if(GI[icon]) o += '<svg x="23" y="23" width="54" height="54" viewBox="0 0 512 512"><path fill="' + ink5 + '" d="' + GI[icon] + '"/></svg>';
    return (medalCache[key] = o + '</svg>');
  }
  if(rarity >= 4) for(var i = 0; i < 6; i++){
    var a = Math.PI / 180 * (60 * i - 90), b1 = a - .16, b2 = a + .16;
    o += '<polygon fill="' + red + '" points="' + (50 + 49 * Math.cos(a)).toFixed(2) + "," + (50 + 49 * Math.sin(a)).toFixed(2) + " " +
      (50 + 38 * Math.cos(b1)).toFixed(2) + "," + (50 + 38 * Math.sin(b1)).toFixed(2) + " " + (50 + 38 * Math.cos(b2)).toFixed(2) + "," + (50 + 38 * Math.sin(b2)).toFixed(2) + '"/>';
  }
  if(rarity >= 3) o += '<polygon points="' + hexPts(47, 30) + '" fill="none" stroke="' + red + '" stroke-width="1" opacity=".55"/>';
  o += '<polygon points="' + hexPts(42) + '" fill="' + plate + '" stroke="' + red + '" stroke-width="' + (rarity >= 3 ? 5 : 3) + '" stroke-linejoin="miter"/>';
  if(rarity >= 2) o += '<polygon points="' + hexPts(34) + '" fill="none" stroke="' + red + '" stroke-width="1.5" opacity=".85"/>';
  if(rarity >= 3) for(var j = 0; j < 6; j++){
    var c = Math.PI / 180 * (60 * j - 90);
    o += '<rect x="' + (50 + 42 * Math.cos(c) - 3).toFixed(2) + '" y="' + (50 + 42 * Math.sin(c) - 3).toFixed(2) + '" width="6" height="6" fill="' + hi + '"/>';
  }
  if(rarity >= 4) o += '<polygon points="' + hexPts(29) + '" fill="none" stroke="' + hi + '" stroke-width="1" stroke-dasharray="2 3"/>';
  var ink = rarity >= 4 && earned ? hi : red;
  if(GI[icon]) o += '<svg x="' + (rarity >= 2 ? 23 : 21) + '" y="' + (rarity >= 2 ? 23 : 21) + '" width="' + (rarity >= 2 ? 54 : 58) + '" height="' + (rarity >= 2 ? 54 : 58) + '" viewBox="0 0 512 512"><path fill="' + ink + '" d="' + GI[icon] + '"/></svg>';
  else o += '<svg x="31" y="31" width="38" height="38" viewBox="0 0 8 8" shape-rendering="crispEdges"><path fill="' + ink + '" d="' + pixPath(icon) + '"/></svg>';
  return (medalCache[key] = o + '</svg>');
}
function medal(icon, rarity, earned, cls){
  var e = document.createElement("i");
  e.className = "pl-medal r" + rarity + (earned ? " on" : "") + (cls ? " " + cls : "");
  e.innerHTML = medalSvg(icon, rarity, earned);
  return e;
}
function emb(name, cls){
  var e = document.createElement("i");
  e.className = "pl-emb" + (cls ? " " + cls : "");
  e.innerHTML = pixSvg(name);
  return e;
}
// --- loud mode: tiny chiptune sounds (made on the fly, no files), falling squares, a big card ---
var actx = null;
var SFX = {
  xp:[[660, 0, .08], [990, .07, .1]],
  quest:[[523, 0, .09], [659, .08, .09], [784, .16, .16]],
  badge:[[784, 0, .08], [988, .08, .08], [1175, .16, .08], [1568, .24, .22]],
  level:[[523, 0, .1], [659, .1, .1], [784, .2, .1], [1047, .3, .12], [784, .44, .08], [1047, .52, .4]],
  boss:[[110, 0, .25, "sawtooth"], [82, .22, .3, "sawtooth"], [523, .6, .1], [659, .7, .1], [784, .8, .1], [1047, .9, .45]],
  reward:[[988, 0, .06], [1319, .06, .12], [1047, .22, .08], [1319, .3, .08], [1568, .38, .4]]
};
function sound(kind){
  var seq = SFX[kind];
  if(!seq) return;
  try{
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if(actx.state === "suspended") actx.resume();
    var t0 = actx.currentTime + .02;
    seq.forEach(function(n){
      var o = actx.createOscillator(), gn = actx.createGain();
      o.type = n[3] || "square"; o.frequency.value = n[0];
      gn.gain.setValueAtTime(0.0001, t0 + n[1]);
      gn.gain.exponentialRampToValueAtTime(0.05, t0 + n[1] + .01);
      gn.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
      o.connect(gn); gn.connect(actx.destination);
      o.start(t0 + n[1]); o.stop(t0 + n[1] + n[2] + .03);
    });
  }catch(e){}
}
function calm(){ return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
function confetti(n){
  if(calm()) return;
  var layer = document.createElement("div");
  layer.className = "pl-confetti"; layer.setAttribute("aria-hidden", "true");
  for(var i = 0; i < n; i++){
    var c = document.createElement("i");
    c.style.left = (Math.random() * 100) + "%";
    c.style.setProperty("--dx", Math.round(Math.random() * 240 - 120) + "px");
    c.style.setProperty("--r", Math.round(Math.random() * 900 - 450) + "deg");
    c.style.animationDelay = (Math.random() * .35).toFixed(2) + "s";
    c.style.animationDuration = (1.3 + Math.random() * 1.1).toFixed(2) + "s";
    if(Math.random() < .35) c.className = "w";
    layer.appendChild(c);
  }
  document.body.appendChild(layer);
  setTimeout(function(){ if(layer.parentNode) layer.parentNode.removeChild(layer); }, 3000);
}
var celeEl = null, celeTimer = null;
function bigCard(title, name, sub, icon){
  if(!celeEl){
    celeEl = document.createElement("div"); celeEl.className = "pl-cele"; celeEl.setAttribute("role", "alertdialog");
    celeEl.addEventListener("click", function(){ celeEl.hidden = true; });
    document.addEventListener("keydown", function(e){ if(e.key === "Escape" && celeEl && !celeEl.hidden) celeEl.hidden = true; });
    document.body.appendChild(celeEl);
  }
  celeEl.innerHTML = "";
  var card = document.createElement("div"); card.className = "pl-celecard";
  [["pl-celei", icon], ["pl-celet", title], ["pl-celen", name], ["pl-celes", sub], ["pl-celetap", "tap anywhere"]].forEach(function(x){
    if(!x[1]) return;
    var e = document.createElement("div"); e.className = x[0];
    if(x[0] === "pl-celei"){
      if(typeof x[1] === "object"){ e.innerHTML = medalSvg(x[1].icon, x[1].r, true); e.className += " medal r" + x[1].r; }
      else e.innerHTML = pixSvg(x[1]);
    }else e.textContent = x[1];
    card.appendChild(e);
  });
  celeEl.appendChild(card);
  celeEl.hidden = false;
  clearTimeout(celeTimer);
  celeTimer = setTimeout(function(){ celeEl.hidden = true; }, 4200);
}
var toastQ = [], toastEl = null, toastBusy = false;
// one small toast at a time, bottom left: level ups, badges, quests, XP
function toast(big, small){
  toastQ.push([big, small]);
  if(toastBusy) return;
  (function next(){
    var m = toastQ.shift();
    if(!m){ toastBusy = false; if(toastEl) toastEl.hidden = true; return; }
    toastBusy = true;
    if(!toastEl){ toastEl = document.createElement("div"); toastEl.className = "pl-toast"; toastEl.setAttribute("role", "status"); document.body.appendChild(toastEl); }
    toastEl.innerHTML = "";
    var b = document.createElement("b"); b.textContent = m[0]; toastEl.appendChild(b);
    if(m[1]){ var sm = document.createElement("small"); sm.textContent = m[1]; toastEl.appendChild(sm); }
    toastEl.hidden = false;
    toastEl.classList.remove("pop"); void toastEl.offsetWidth; toastEl.classList.add("pop");
    setTimeout(next, m[0].indexOf("level") === 0 ? 3200 : 2200);
  })();
}
function mount(ctx){
  var p = ctx.page, P = p.planner, root = ctx.root;
  var GM = ctx.game || GM;      // the site-wide game record (falls back to this page's own)
  var u = uiState[p.id] || (uiState[p.id] = { view:"day", date:today(), form:null, tplSave:false, flash:"", qarea:"personal" });
  function commit(){ gameStep(); ctx.save(); draw(); }
  function areaName(a){ return a === "personal" ? "personal" : P.areas[a].name; }

  // ----- occurrences -----
  var ix = { byDate:{}, over:{}, spans:[] }, byDate = ix.byDate, over = ix.over;
  function buildIndex(){ ix = indexOf(P); byDate = ix.byDate; over = ix.over; }
  function ruleById(id){ for(var i = 0; i < P.rules.length; i++) if(P.rules[i].id === id) return P.rules[i]; return null; }
  function itemsOn(date){ return itemsFor(P, ix, date); }
  // the first day of the week holding `s`, by the chosen start day
  function wkStart(s){ return addDays(s, -((wd(s) - P.settings.weekStart + 7) % 7)); }
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
      if(it.allDay) return;
      if(isFlex(it)){ s.flex += mins(it); return; }
      s.total++; s.sched += mins(it); if(it.done) s.done++;
    });
    return s;
  }
  // ===== GAME =====
  // XP only for finished work: CWES and side hustle 60 XP an hour, the first gym
  // session of a day 50, work 20 an hour, personal 10; !!! adds 15; about one in
  // seven finished things is a "crit" for double. +50 for clearing a day, +30 a
  // quest, +200 a weekly boss. Rest days never break the cleared-day streak.
  var QDEF = {
    cwes1:{ label:"finish a CWES block", ok:function(c){ return c.planN.cwes > 0; }, done:function(c){ return c.doneN.cwes > 0; } },
    cwes60:{ label:"1h of CWES", ok:function(c){ return c.planMin.cwes >= 60; }, done:function(c){ return c.doneMin.cwes >= 60; } },
    gym:{ label:"hit the gym", ok:function(c){ return c.planN.gym > 0; }, done:function(c){ return c.doneN.gym > 0; } },
    side60:{ label:"1h on the side hustle", ok:function(c){ return c.planMin.side >= 60; }, done:function(c){ return c.doneMin.side >= 60; } },
    money:{ label:"30m of marketing or selling", ok:function(c){ return c.planN.side > 0; }, done:function(c){ return c.money >= 30; } },
    early:{ label:"finish something before 9:00", ok:function(c){ return c.earlyPlan; }, done:function(c){ return c.earlyDone; } },
    clear:{ keep:true, label:"clear the day", ok:function(c){ return c.total > 0; }, done:function(c){ return c.total > 0 && c.done === c.total; } },
    prio:{ label:"finish a !!! task", ok:function(c){ return c.prio3 > 0; }, done:function(c){ return c.prio3Done > 0; } },
    refl:{ label:"write today's reflection", ok:function(){ return true; }, done:function(c){ return !!P.reflect[c.date]; } },
    plan:{ label:"plan tomorrow", ok:function(){ return true; }, done:function(c){ return (byDate[addDays(c.date, 1)] || []).length > 0; } },
    // elite quests: from level 10 the third quest is one of these, worth double
    moneylog:{ label:"log today's money", ok:function(){ return !!finDays; }, done:function(c){ return !!(finDays && finDays[c.date]); } },
    e_cwes120:{ elite:true, xp:60, label:"2h of CWES", ok:function(c){ return c.planN.cwes > 0; }, done:function(c){ return c.doneMin.cwes >= 120; } },
    e_deep:{ elite:true, xp:60, label:"4h of deep work (CWES + side)", ok:function(c){ return c.planMin.cwes + c.planMin.side >= 120; }, done:function(c){ return c.doneMin.cwes + c.doneMin.side >= 240; } },
    e_gymstudy:{ elite:true, xp:60, label:"gym and 1h of CWES on the same day", ok:function(c){ return c.planN.gym > 0 && c.planN.cwes > 0; }, done:function(c){ return c.doneN.gym > 0 && c.doneMin.cwes >= 60; } },
    e_early2:{ elite:true, xp:60, label:"finish 2 things before 9:00", ok:function(c){ return c.earlyPlanN >= 2; }, done:function(c){ return c.earlyDoneN >= 2; } },
    e_bigday:{ keep:true, elite:true, xp:60, label:"clear a 6h+ day", ok:function(c){ return c.planTotal >= 360; }, done:function(c){ return c.total > 0 && c.done === c.total; } },
    e_money60:{ elite:true, xp:60, label:"1h of marketing or selling", ok:function(c){ return c.planN.side > 0; }, done:function(c){ return c.money >= 60; } }
  };
  // caches tied to the current index (a new index after every change starts them fresh)
  var memo = { ix:null, day:{}, cwes:null, early:null };
  function fresh_(){ if(memo.ix !== ix) memo = { ix:ix, day:{}, cwes:null, early:null }; }
  function cwesDone(){
    fresh_();
    if(!memo.cwes){
      memo.cwes = {}; memo.early = {};
      P.acts.forEach(function(a){
        if(!a.done || a.area !== "cwes" || notTask(a)) return;
        memo.cwes[a.date] = (memo.cwes[a.date] || 0) + mins(a);
        if(a.start != null && a.start >= DAWN && a.start < 540) memo.early[a.date] = 1;
      });
    }
    return memo.cwes;
  }
  function dayCtx(d){
    fresh_();
    return memo.day[d] || (memo.day[d] = dayCtx0(d));
  }
  function dayCtx0(d){
    var c = { date:d, total:0, done:0, planN:{}, planMin:{}, doneN:{}, doneMin:{}, money:0, earlyPlan:false, earlyDone:false, prio3:0, prio3Done:0,
              earlyPlanN:0, earlyDoneN:0, planTotal:0, subN:{}, subPlan:{}, topicN:{}, topicMin:{}, cwesStarts:[], cwesPlanStarts:[], maxBlock:{}, planMax:{},
              prio2:0, prio2Done:0, long90:0, reflN:0, tomN:0, tomCwes:0, yCwes:0, notesN:0 };
    AREAS.forEach(function(a){ c.planN[a] = 0; c.planMin[a] = 0; c.doneN[a] = 0; c.doneMin[a] = 0; });
    itemsOn(d).forEach(function(it){
      if(notTask(it)) return;
      var m = mins(it);
      c.total++; c.planN[it.area]++; c.planMin[it.area] += m; c.planTotal += m;
      if(it.start != null && it.start >= DAWN && it.start < 540){ c.earlyPlan = true; c.earlyPlanN++; if(it.done){ c.earlyDone = true; c.earlyDoneN++; } }
      if(it.prio === 3){ c.prio3++; if(it.done) c.prio3Done++; }
      if(it.prio >= 2){ c.prio2++; if(it.done) c.prio2Done++; }
      var sk = it.area + "." + (it.sub || "");
      c.subPlan[sk] = (c.subPlan[sk] || 0) + 1;
      if(it.area === "cwes" && it.start != null && it.start >= DAWN) c.cwesPlanStarts.push(it.start);
      c.planMax[it.area] = Math.max(c.planMax[it.area] || 0, m);
      if(it.done){
        c.done++; c.doneN[it.area]++; c.doneMin[it.area] += m; if(it.area === "side" && MONEY_SUBS.indexOf(it.sub) >= 0) c.money += m;
        c.subN[sk] = (c.subN[sk] || 0) + 1;
        c.maxBlock[it.area] = Math.max(c.maxBlock[it.area] || 0, m);
        if(it.area === "cwes"){
          if(it.start != null && it.start >= DAWN) c.cwesStarts.push(it.start);
          if(m >= 90) c.long90++;
          if((it.notes || "").trim().length >= 10) c.notesN++;
          // topic quests count blocks with the topic's word in their title or notes
          var txt = (it.title + " " + (it.notes || "")).toLowerCase();
          TOPICS.forEach(function(T){ if(txt.indexOf(T[1]) >= 0){ c.topicN[T[0]] = (c.topicN[T[0]] || 0) + 1; c.topicMin[T[0]] = (c.topicMin[T[0]] || 0) + m; } });
        }
      }
    });
    var refl = P.reflect[d]; c.reflN = refl ? Object.keys(refl).length : 0;
    // finished work is always a saved activity (ticking a repeat saves it), so P.acts has all of it
    c.yCwes = cwesDone()[addDays(d, -1)] || 0;
    var tom = byDate[addDays(d, 1)] || [];
    c.tomN = tom.length; c.tomCwes = tom.filter(function(a){ return a.area === "cwes"; }).length;
    return c;
  }
  // the week so far, for weekly quests
  function weekCtx(mon){
    var t = today(), w = { min:{}, cwesDays:0, sub:{}, revDays:0, topicN:{}, long90:0, earlyDays:0, cwes60:0, gymDays:0, cleared:0, moneyDays:0, reflDays:0, notesDays:0, lastCwes:0 };
    AREAS.forEach(function(a){ w.min[a] = 0; });
    for(var k = 0; k < 7; k++){
      var d = addDays(mon, k);
      if(d > t) break;
      var c = dayCtx(d);
      AREAS.forEach(function(a){ w.min[a] += c.doneMin[a]; });
      if(c.doneN.cwes > 0) w.cwesDays++;
      Object.keys(c.subN).forEach(function(x){ w.sub[x] = (w.sub[x] || 0) + c.subN[x]; });
      if(c.subN["cwes.revision"]) w.revDays++;
      Object.keys(c.topicN).forEach(function(x){ w.topicN[x] = (w.topicN[x] || 0) + c.topicN[x]; });
      w.long90 += c.long90;
      if(c.cwesStarts.some(function(x){ return x < 540; })) w.earlyDays++;
      if(c.doneMin.cwes >= 60) w.cwes60++;
      if(c.notesN > 0) w.notesDays++;
      if(c.doneN.gym > 0) w.gymDays++;
      if(!P.rest[d] && c.total > 0 && c.done === c.total) w.cleared++;
      if(finDays && finDays[d]) w.moneyDays++;
      if(P.reflect[d]) w.reflDays++;
    }
    var B = bossOf(mon, weekStats(mon));
    w.bossDead = B.dead; w.bossMax = B.max;
    var cd = cwesDone();
    for(var j = -7; j < 0; j++) w.lastCwes += cd[addDays(mon, j)] || 0;
    // mornings you actually study: days in the last four weeks with a finished CWES block before 9:00
    w.earlyHabit = 0;
    for(var j2 = -28; j2 <= 6; j2++){ var dj = addDays(mon, j2); if(dj <= t && memo.early[dj]) w.earlyHabit++; }
    // days still to come this week, today included (a week drawn mid-week never asks for more days than are left)
    var last = addDays(mon, 6);
    w.daysLeft = last < t ? 0 : Math.round((Date.parse(last) - Date.parse(mon > t ? mon : t)) / 864e5) + 1;
    return w;
  }

  // ===== QUEST GENERATOR =====
  // Daily and weekly quests are made from templates x amounts x CWES topics, picked by a
  // seeded random draw for the date (the same picks every time), weighted toward the main
  // priority, and harder as the level grows. Their ids ("d:cwesmin:90", "w:topicw:xss.3",
  // "e:..." for elite) say everything needed to check them later.
  var TOPICS = [["sqli", "sqli", "SQL injection"], ["xss", "xss", "XSS"], ["ssrf", "ssrf", "SSRF"], ["idor", "idor", "IDOR"], ["xxe", "xxe", "XXE"],
    ["lfi", "inclusion", "file inclusion"], ["upload", "upload", "file upload"], ["cmdi", "command", "command injection"], ["ssti", "ssti", "SSTI"],
    ["csrf", "csrf", "CSRF"], ["jwt", "jwt", "JWT"], ["auth", "auth", "auth bypass"], ["deser", "deserial", "deserialization"], ["race", "race", "race conditions"],
    ["smuggle", "smuggl", "request smuggling"], ["graphql", "graphql", "GraphQL"], ["api", "api", "API testing"], ["cache", "cache", "web cache poisoning"],
    ["oauth", "oauth", "OAuth"], ["proto", "prototype", "prototype pollution"], ["recon", "recon", "recon"], ["burp", "burp", "Burp Suite"],
    ["fuzz", "fuzz", "fuzzing"], ["nosql", "nosql", "NoSQL injection"], ["xpath", "xpath", "XPath injection"], ["cors", "cors", "CORS"],
    ["clickjack", "clickjack", "clickjacking"], ["session", "session", "session attacks"], ["ldap", "ldap", "LDAP injection"], ["ws", "websocket", "WebSockets"],
    ["traversal", "traversal", "path traversal"], ["redirect", "redirect", "open redirects"], ["hosthdr", "host header", "host header attacks"],
    ["crlf", "crlf", "CRLF injection"], ["dom", "dom", "DOM-based bugs"], ["massassign", "mass assign", "mass assignment"], ["saml", "saml", "SAML"],
    ["twofa", "2fa", "2FA bypass"], ["logic", "logic", "business logic flaws"], ["report", "report", "report writing"]];
  function topicParams(sfx){ var o = []; TOPICS.forEach(function(T){ sfx.forEach(function(x){ o.push(T[0] + "." + x); }); }); return o; }
  function topicBy(slug){ for(var i = 0; i < TOPICS.length; i++) if(TOPICS[i][0] === slug) return TOPICS[i]; return null; }
  function fmtM(m){ m = Math.round(m); return m >= 60 ? (m % 60 ? Math.round(m / 6) / 10 : m / 60) + "h" : m + "m"; }
  function pl(n, one, many){ return n === 1 ? one : n + " " + many; }
  var DT = {
    cwesmin:{ family:"time", area:"cwes", params:[30, 45, 60, 90, 120, 150, 180],
      make:function(p){ var m = +p; return { label:fmtM(m) + " of CWES", xp:Math.round(15 + m / 3), unit:"m",
        prog:function(c){ return [c.doneMin.cwes, m]; }, ok:function(c){ return m <= 60 || c.planMin.cwes >= m * .75; } }; } },
    cwessub:{ area:"cwes", structured:true, params:["lab.1", "theory.1", "revision.1", "lab.2", "theory.2", "lab.3"],
      tier:function(p){ return +p.split(".")[1] - 1; },
      make:function(p){ var x = p.split("."), n = +x[1]; return { label:"finish " + pl(n, "a CWES " + x[0] + " block", "CWES " + x[0] + " blocks"), xp:20 + 15 * n,
        prog:function(c){ return [c.subN["cwes." + x[0]] || 0, n]; }, ok:function(c){ return n === 1 || (c.subPlan["cwes." + x[0]] || 0) >= n; } }; } },
    topic:{ family:"time", area:"cwes", structured:true, params:topicParams(["block", "hour"]), tier:function(p){ return /hour$/.test(p) ? 2 : 1; },
      make:function(p){ var x = p.split("."), T = topicBy(x[0]); if(!T) return null; var hr = x[1] === "hour";
        return { label:(hr ? "1h of CWES on " : "a CWES block on ") + T[2], tip:"counts CWES blocks with “" + T[1] + "” in the title or notes", xp:hr ? 60 : 40, unit:hr ? "m" : "",
          prog:function(c){ return hr ? [c.topicMin[T[0]] || 0, 60] : [c.topicN[T[0]] || 0, 1]; } }; } },
    early:{ area:"cwes", params:[10, 9, 8, 7],
      make:function(p){ var hh = +p; return { label:"a CWES block that starts before " + pad(hh) + ":00", xp:25 + (10 - hh) * 10,
        tip:"a CWES block you finish that starts between 04:00 and " + pad(hh) + ":00", late:hh * 60,
        prog:function(c){ return [c.cwesStarts.filter(function(x){ return x < hh * 60; }).length, 1]; },
        // only offered on days whose plan already has a morning CWES block: it never tells you when to study
        ok:function(c){ return c.cwesPlanStarts.some(function(x){ return x < hh * 60; }); } }; } },
    deep:{ family:"time", area:"cwes", structured:true, params:[60, 90, 120],
      make:function(p){ var m = +p; return { label:"one CWES block of " + fmtM(m) + " or longer", xp:Math.round(20 + m / 3), unit:"m",
        prog:function(c){ return [c.maxBlock.cwes || 0, m]; }, ok:function(c){ return m === 60 || (c.planMax.cwes || 0) >= m; } }; } },
    focusmin:{ family:"time", area:"cwes", params:[60, 120, 180, 240],
      make:function(p){ var m = +p; return { label:fmtM(m) + " of focused work", tip:"CWES and side hustle time both count", xp:Math.round(15 + m / 4), unit:"m",
        prog:function(c){ return [c.doneMin.cwes + c.doneMin.side, m]; }, ok:function(c){ return m <= 120 || c.planMin.cwes + c.planMin.side >= m * .75; } }; } },
    beat:{ family:"time", area:"cwes", params:["yday"],
      make:function(){ return { label:"beat yesterday's CWES time", tip:"more CWES time than yesterday", xp:40, unit:"m",
        prog:function(c){ return [c.doneMin.cwes, c.yCwes + 5]; }, ok:function(c){ return c.yCwes >= 30; } }; } },
    cwesall:{ area:"cwes", params:["all"],
      make:function(){ return { label:"finish every CWES block you planned", xp:35,
        prog:function(c){ return [c.doneN.cwes, c.planN.cwes]; }, ok:function(c){ return c.planN.cwes > 0; } }; } },
    notes:{ area:"cwes", params:["one"],
      make:function(){ return { label:"note what you learned in a CWES block", tip:"a finished CWES block with a line or more in its notes", xp:25,
        prog:function(c){ return [c.notesN > 0 ? 1 : 0, 1]; }, ok:function(c){ return c.planN.cwes > 0; } }; } },
    things:{ area:"any", params:[3, 4, 5, 6, 8],
      make:function(p){ var n = +p; return { label:"finish " + n + " things today", xp:10 + n * 6,
        prog:function(c){ return [c.done, n]; }, ok:function(c){ return c.total >= n; } }; } },
    clear:{ area:"any", params:["day"],
      make:function(){ return { label:"clear the day", keep:true, xp:30, prog:function(c){ return [c.total > 0 && c.done === c.total ? 1 : 0, 1]; }, ok:function(c){ return c.total > 0; } }; } },
    gym:{ area:"gym", params:["go", "cwes30", "cwes60"],
      make:function(p){ var m = p === "go" ? 0 : +p.slice(4); return { label:m ? "gym and " + fmtM(m) + " of CWES" : "hit the gym", xp:m ? 30 + m / 2 : 30,
        prog:function(c){ return m ? [(c.doneN.gym > 0 ? 1 : 0) + (c.doneMin.cwes >= m ? 1 : 0), 2] : [c.doneN.gym > 0 ? 1 : 0, 1]; }, ok:function(c){ return c.planN.gym > 0; } }; } },
    side:{ family:"time", area:"side", params:[30, 60, 90],
      make:function(p){ var m = +p; return { label:fmtM(m) + " on the side hustle", xp:Math.round(15 + m / 3), unit:"m",
        prog:function(c){ return [c.doneMin.side, m]; }, ok:function(c){ return c.planMin.side >= m * .75; } }; } },
    money:{ area:"any", params:["log"],
      make:function(){ return { label:"log today's money", xp:25, prog:function(c){ return [finDays && finDays[c.date] ? 1 : 0, 1]; }, ok:function(){ return !!finDays; } }; } },
    plan:{ area:"any", params:["tomorrow", "cwes"],
      make:function(p){ var cw = p === "cwes"; return { label:cw ? "plan a CWES block for tomorrow" : "plan tomorrow", xp:cw ? 30 : 20,
        prog:function(c){ return [(cw ? c.tomCwes : c.tomN) > 0 ? 1 : 0, 1]; } }; } },
    refl:{ area:"any", params:["write", "all"],
      make:function(p){ var all = p === "all"; return { label:all ? "answer all 4 reflection questions" : "write today's reflection", xp:all ? 40 : 25,
        prog:function(c){ return [Math.min(c.reflN, all ? 4 : 1), all ? 4 : 1]; } }; } },
    prio:{ area:"any", params:["one", "all"],
      make:function(p){ var all = p === "all"; return { label:all ? "finish every !! and !!! task" : "finish a !!! task", keep:all, xp:all ? 50 : 35,
        prog:function(c){ return all ? [c.prio2Done, c.prio2] : [c.prio3Done > 0 ? 1 : 0, 1]; }, ok:function(c){ return all ? c.prio2 > 1 : c.prio3 > 0; } }; } }
  };
  var WT = {
    cwesh:{ family:"wtime", area:"cwes", params:[3, 5, 7, 10, 12, 15, 20],
      make:function(p){ var n = +p; return { label:n + "h of CWES this week", xp:40 + n * 12, unit:"h", prog:function(w){ return [w.min.cwes / 60, n]; } }; } },
    cwesdays:{ family:"wdays", area:"cwes", perDay:true, params:[3, 4, 5, 6, 7],
      make:function(p){ var n = +p; return { label:"study CWES on " + n + " days", xp:40 + n * 15, prog:function(w){ return [w.cwesDays, n]; } }; } },
    labs:{ area:"cwes", structured:true, params:[2, 3, 5, 8, 10],
      make:function(p){ var n = +p; return { label:"finish " + n + " CWES labs", xp:40 + n * 15, prog:function(w){ return [w.sub["cwes.lab"] || 0, n]; } }; } },
    rev:{ perDay:true, area:"cwes", structured:true, params:[2, 3, 4],
      make:function(p){ var n = +p; return { label:"revise CWES on " + n + " days", xp:50 + n * 15, prog:function(w){ return [w.revDays, n]; } }; } },
    topicw:{ area:"cwes", structured:true, params:topicParams(["2", "3"]), tier:function(p){ return /3$/.test(p) ? 2 : 1; },
      make:function(p){ var x = p.split("."), T = topicBy(x[0]), n = +x[1]; if(!T) return null;
        return { label:T[2] + " week: " + n + " CWES blocks on it", tip:"counts CWES blocks with “" + T[1] + "” in the title or notes", xp:80 + n * 20,
          prog:function(w){ return [w.topicN[T[0]] || 0, n]; } }; } },
    deepw:{ area:"cwes", structured:true, params:[2, 3, 5],
      make:function(p){ var n = +p; return { label:n + " CWES blocks of 90m or longer", xp:60 + n * 25, prog:function(w){ return [w.long90, n]; } }; } },
    beatw:{ family:"wtime", area:"cwes", params:["lastweek"],
      make:function(){ return { label:"beat last week's CWES hours", tip:"more CWES time than last week", xp:120, unit:"h",
        prog:function(w){ return [w.min.cwes / 60, Math.floor(w.lastCwes / 6 + 1) / 10]; }, ok:function(w){ return w.lastCwes >= 120; } }; } },
    notesw:{ perDay:true, area:"cwes", params:[3, 5],
      make:function(p){ var n = +p; return { label:"note what you learned on " + n + " days", tip:"days with a finished CWES block that has a line or more in its notes", xp:50 + n * 15,
        prog:function(w){ return [w.notesDays, n]; } }; } },
    earlyw:{ area:"cwes", params:[2, 3, 5], perDay:true, lateDay:540,
      make:function(p){ var n = +p; return { label:"start CWES before 9:00 on " + n + " days", tip:"CWES blocks you finish that start between 04:00 and 09:00", xp:50 + n * 20,
        prog:function(w){ return [w.earlyDays, n]; }, ok:function(w){ return w.earlyHabit >= Math.min(n, 2); } }; } },
    nozerow:{ family:"wdays", area:"cwes", perDay:true, params:[3, 5, 7],
      make:function(p){ var n = +p; return { label:"1h+ of CWES on " + n + " days", xp:60 + n * 20, prog:function(w){ return [w.cwes60, n]; } }; } },
    gymw:{ perDay:true, area:"gym", params:[2, 3, 4, 5],
      make:function(p){ var n = +p; return { label:n + " gym sessions", xp:40 + n * 20, prog:function(w){ return [w.gymDays, n]; } }; } },
    clearw:{ perDay:true, area:"any", params:[3, 4, 5, 6, 7],
      make:function(p){ var n = +p; return { label:"clear " + n + " days", xp:40 + n * 20, prog:function(w){ return [w.cleared, n]; } }; } },
    moneyw:{ perDay:true, area:"any", params:[5, 7],
      make:function(p){ var n = +p; return { label:"log money on " + n + " days", xp:50 + n * 10, prog:function(w){ return [w.moneyDays, n]; }, ok:function(){ return !!finDays; } }; } },
    reflw:{ perDay:true, area:"any", params:[3, 5, 7],
      make:function(p){ var n = +p; return { label:"write " + n + " reflections", xp:40 + n * 12, prog:function(w){ return [w.reflDays, n]; } }; } },
    boss:{ area:"any", params:["beat"],
      make:function(){ return { label:"beat this week's boss", xp:150, prog:function(w){ return [w.bossDead ? 1 : 0, 1]; }, ok:function(w){ return w.bossMax > 0; } }; } },
    sidew:{ area:"side", params:[2, 4, 6],
      make:function(p){ var n = +p; return { label:n + "h on the side hustle", xp:40 + n * 15, unit:"h", prog:function(w){ return [w.min.side / 60, n]; },
        ok:function(){ return P.areas.side.target > 0; } }; } }
  };
  // a small seeded random generator, so a date always draws the same quests
  function rng(seed){
    var a = hash(seed);
    return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; var x = Math.imul(a ^ a >>> 15, 1 | a); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; };
  }
  function wpick(list, R){ var tot = 0; list.forEach(function(o){ tot += o.w; }); var r = R() * tot; for(var i = 0; i < list.length; i++){ r -= list[i].w; if(r <= 0) return list[i]; } return list[list.length - 1]; }
  // the first pick is always the main priority; after that its templates weigh a bit more,
  // gym stays in the mix, and the side hustle only comes up now and then unless it's the priority
  function areaW(a, focus){
    if(focus === "balanced") return a === "any" ? 1 : 1.2;
    if(a === focus) return 1.3;
    if(a === "gym") return 1.5;
    if(a === "side") return .25;
    return 1;
  }
  function pickGen(defs, prefix, seed, ctxv, n, firstN, exclude){
    var R = rng(seed), lvl = GM.level || 1, tmax = lvl < 6 ? 0 : lvl < 12 ? 1 : lvl < 20 ? 2 : 3, focus = P.settings.focus || "cwes";
    var flexible = (P.settings.questStyle || "flexible") !== "structured";
    var groups = Object.keys(defs).filter(function(k){ return !(exclude && exclude[k]) && !(flexible && defs[k].structured); }).map(function(k){
      var D = defs[k], opts = [];
      D.params.forEach(function(pp, i){
        var q = D.make(String(pp));
        if(!q || (q.ok && !q.ok(ctxv))) return;
        if(D.perDay && ctxv && ctxv.daysLeft != null){ var pr0 = q.prog(ctxv); if(Math.floor(pr0[0]) + ctxv.daysLeft < pr0[1]) return; }
        var tr = D.tier ? D.tier(String(pp)) : (D.params.length > 1 ? Math.round(i / (D.params.length - 1) * 3) : 1);
        if(tr > tmax + 1) return;
        opts.push({ p:String(pp), w:tr === tmax ? 3 : tr === tmax + 1 ? 1 : tr === tmax - 1 ? 1.5 : .5 });
      });
      return { k:k, area:D.area, fam:D.family || "", opts:opts, w:areaW(D.area, focus) };
    }).filter(function(g){ return g.opts.length; });
    var out = [];
    for(var i = 0; i < n && groups.length; i++){
      var pool = groups;
      if(i < (firstN || 0) && focus !== "balanced"){ var f = groups.filter(function(g){ return g.area === focus; }); if(f.length) pool = f; }
      var g = wpick(pool, R), o = wpick(g.opts, R);
      out.push({ id:prefix + g.k + ":" + o.p, k:g.k });
      groups = groups.filter(function(x){ return x !== g && !(g.fam && x.fam === g.fam); });
    }
    return out;
  }
  // today's three: one from the main priority first; from level 10 the third is elite (double xp)
  function pickDaily(d, c){
    var picks = pickGen(DT, "d:", "D" + d, c, 3, 1);
    if((GM.level || 0) >= 10 && picks.length >= 3){
      var ex = {}; picks.slice(0, 2).forEach(function(q){ ex[q.k] = 1; var f = DT[q.k] && DT[q.k].family;
        if(f) Object.keys(DT).forEach(function(k){ if(DT[k].family === f) ex[k] = 1; }); });
      var el = pickGen(DT, "e:", "E" + d, c, 1, 1, ex);
      if(el.length) picks[2] = el[0];
    }
    return picks.map(function(q){ return q.id; });
  }
  function pickWeekly(mon, w){ return pickGen(WT, "w:", "W" + mon, w, 3, 2).map(function(q){ return q.id; }); }
  // any quest id, old or generated, as { label, xp, elite, weekly, unit, tip, prog(ctx) }
  function resolveQ(id){
    if(QDEF[id]){ var L = QDEF[id]; return { id:id, label:L.label, xp:L.xp || 30, elite:!!L.elite, keep:!!L.keep, unit:"", late:id === "early" || id === "e_early2" ? 540 : 0,
      prog:function(c){ return [L.done(c) ? 1 : 0, 1]; } }; }
    var m = /^([dew]):([a-z0-9]+):(.+)$/.exec(id);
    if(!m) return null;
    var D = (m[1] === "w" ? WT : DT)[m[2]];
    if(!D) return null;
    var q = D.make(m[3]);
    if(!q) return null;
    return { id:id, label:q.label, xp:m[1] === "e" ? q.xp * 2 : q.xp, elite:m[1] === "e", weekly:m[1] === "w", unit:q.unit || "", tip:q.tip || "", prog:q.prog,
      keep:!!q.keep, late:q.late || 0, perDay:!!D.perDay, lateDay:D.lateDay || 0 };
  }
  function wonQ(d, id){ return !!(GM.qwon && GM.qwon[d] && GM.qwon[d].indexOf(id) >= 0); }
  function misfit(ids, done){
    if((P.settings.questStyle || "flexible") === "structured" || done) return false;
    return ids.some(function(id){ var m = /^[dew]:([a-z0-9]+):/.exec(id); if(!m) return false; var D = DT[m[1]] || WT[m[1]]; return !!(D && D.structured); });
  }
  function progText(q){
    if(q.unit === "m") return fmtM(Math.min(q.have, q.need)) + "/" + fmtM(q.need);
    if(q.unit === "h") return num(Math.min(q.have, q.need)) + "/" + q.need + "h";
    return Math.floor(Math.min(q.have, q.need)) + "/" + q.need;
  }
  function pickQuests(d){
    var c = dayCtx(d), byHash = function(a, b){ return hash(d + a) - hash(d + b); };
    var base = Object.keys(QDEF).filter(function(id){ return !QDEF[id].elite && QDEF[id].ok(c); }).sort(byHash).slice(0, 3);
    if((GM.level || 0) >= 10){
      var elite = Object.keys(QDEF).filter(function(id){ return QDEF[id].elite && QDEF[id].ok(c); }).sort(byHash);
      if(elite.length) base = base.slice(0, 2).concat([elite[0]]);
    }
    return base;
  }
  var ACH_VERSION = 5;   // bump when badges are added: ones already earned then unlock quietly
  var ACH_GROUPS = ["hardcore", "streaks", "cwes", "side hustle", "gym", "quests & bosses", "money & trackers", "xp", "life"];
  var ACH = [
    // streaks: cleared days
    ["first", "first blood", "finish your first activity", function(S){ return [S.firstDone ? 1 : 0, 1]; }, "streaks"],
    ["clear1", "clean sweep", "clear a whole day", function(S){ return [S.clearN, 1]; }, "streaks"],
    ["streak3", "warming up", "3 cleared days in a row", function(S){ return [S.best, 3]; }, "streaks"],
    ["streak7", "one week strong", "7 cleared days in a row", function(S){ return [S.best, 7]; }, "streaks"],
    ["streak21", "three weeks", "21 cleared days in a row", function(S){ return [S.best, 21]; }, "streaks"],
    ["streak66", "habit formed", "66 cleared days in a row, about how long a habit takes to stick", function(S){ return [S.best, 66]; }, "streaks"],
    ["streak100", "centurion", "100 cleared days in a row", function(S){ return [S.best, 100]; }, "streaks"],
    ["clear30", "thirty clears", "clear 30 days in total", function(S){ return [S.clearN, 30]; }, "streaks"],
    ["clear100", "hundred club", "clear 100 days in total", function(S){ return [S.clearN, 100]; }, "streaks"],
    ["clear365", "year of doing", "clear 365 days in total", function(S){ return [S.clearN, 365]; }, "streaks"],
    ["perfect", "perfect week", "clear every day of a week (rest days count)", function(S){ return [S.fullWeeks, 1]; }, "streaks"],
    ["perfect4", "perfect month", "4 perfect weeks", function(S){ return [S.fullWeeks, 4]; }, "streaks"],
    // cwes
    ["cwes10", "script kiddie", "10h of CWES study", function(S){ return [S.cwes / 60, 10, "h"]; }, "cwes"],
    ["cwes50", "bug hunter", "50h of CWES study", function(S){ return [S.cwes / 60, 50, "h"]; }, "cwes"],
    ["cwes100", "web exploiter", "100h of CWES study", function(S){ return [S.cwes / 60, 100, "h"]; }, "cwes"],
    ["cwes250", "zero day", "250h of CWES study", function(S){ return [S.cwes / 60, 250, "h"]; }, "cwes"],
    ["lab10", "lab rat", "finish 10 CWES labs", function(S){ return [S.labN, 10]; }, "cwes"],
    ["lab50", "pwned", "finish 50 CWES labs", function(S){ return [S.labN, 50]; }, "cwes"],
    ["rev10", "spaced repetition", "finish 10 revision sessions", function(S){ return [S.revN, 10]; }, "cwes"],
    // side hustle
    ["side10", "side quest", "10h on the side hustle", function(S){ return [S.side / 60, 10, "h"]; }, "side hustle"],
    ["side50", "operator", "50h on the side hustle", function(S){ return [S.side / 60, 50, "h"]; }, "side hustle"],
    ["side100", "founder", "100h on the side hustle", function(S){ return [S.side / 60, 100, "h"]; }, "side hustle"],
    ["side250", "empire", "250h on the side hustle", function(S){ return [S.side / 60, 250, "h"]; }, "side hustle"],
    ["money5", "show me the money", "5h of marketing or selling", function(S){ return [S.money / 60, 5, "h"]; }, "side hustle"],
    ["money20", "rainmaker", "20h of marketing or selling", function(S){ return [S.money / 60, 20, "h"]; }, "side hustle"],
    ["idea10", "idea machine", "finish 10 side-hustle idea tasks", function(S){ return [S.ideaN, 10]; }, "side hustle"],
    // gym
    ["gymweek", "four for four", "hit your gym target in a week", function(S){ return [S.gymWeeks, 1]; }, "gym"],
    ["gymweek4", "four weeks strong", "hit your gym target 4 weeks", function(S){ return [S.gymWeeks, 4]; }, "gym"],
    ["gymweek12", "quarter of gains", "hit your gym target 12 weeks", function(S){ return [S.gymWeeks, 12]; }, "gym"],
    ["gym25", "regular", "25 gym sessions", function(S){ return [S.gymN, 25]; }, "gym"],
    ["gym50", "iron will", "50 gym sessions", function(S){ return [S.gymN, 50]; }, "gym"],
    ["gym100", "gym rat", "100 gym sessions", function(S){ return [S.gymN, 100]; }, "gym"],
    // quests & bosses
    ["quest10", "questing", "finish 10 daily quests", function(S){ return [S.questN, 10]; }, "quests & bosses"],
    ["quest100", "quest master", "finish 100 daily quests", function(S){ return [S.questN, 100]; }, "quests & bosses"],
    ["triple1", "triple threat", "finish all 3 quests in one day", function(S){ return [S.tripleN, 1]; }, "quests & bosses"],
    ["triple10", "hat trick hero", "finish all 3 quests on 10 days", function(S){ return [S.tripleN, 10]; }, "quests & bosses"],
    ["wq1", "on a mission", "finish a weekly quest", function(S){ return [S.weeklyN, 1]; }, "quests & bosses"],
    ["wsweep1", "clean sheet", "finish all 3 weekly quests in a week", function(S){ return [S.sweepN, 1]; }, "quests & bosses"],
    ["wq25", "mission control", "finish 25 weekly quests", function(S){ return [S.weeklyN, 25]; }, "quests & bosses"],
    ["wsweep10", "the professional", "finish all 3 weekly quests on 10 weeks", function(S){ return [S.sweepN, 10]; }, "quests & bosses"],
    ["boss1", "boss slayer", "beat a weekly boss", function(S){ return [S.bosses, 1]; }, "quests & bosses"],
    ["boss4", "champion", "beat 4 weekly bosses", function(S){ return [S.bosses, 4]; }, "quests & bosses"],
    ["boss12", "boss hunter", "beat 12 weekly bosses", function(S){ return [S.bosses, 12]; }, "quests & bosses"],
    ["boss52", "year of victories", "beat 52 weekly bosses", function(S){ return [S.bosses, 52]; }, "quests & bosses"],
    // xp
    ["crit10", "lucky", "land 10 crits", function(S){ return [S.critN, 10]; }, "xp"],
    ["crit50", "critical mass", "land 50 crits", function(S){ return [S.critN, 50]; }, "xp"],
    ["day300", "big day", "earn 300 xp in one day", function(S){ return [S.bestDay, 300, " xp"]; }, "xp"],
    ["day500", "monster day", "earn 500 xp in one day", function(S){ return [S.bestDay, 500, " xp"]; }, "xp"],
    ["xp10k", "ten thousand", "earn 10,000 xp", function(S){ return [S.xp, 10000, " xp"]; }, "xp"],
    ["lvl5", "level 5", "reach level 5", function(S){ return [S.level, 5]; }, "xp"],
    ["lvl10", "level 10", "reach level 10", function(S){ return [S.level, 10]; }, "xp"],
    ["lvl25", "level 25", "reach level 25", function(S){ return [S.level, 25]; }, "xp"],
    ["lvl50", "level 50", "reach level 50", function(S){ return [S.level, 50]; }, "xp"],
    ["lvl100", "level 100", "reach level 100", function(S){ return [S.level, 100]; }, "xp"],
    // life
    ["early5", "early bird", "finish 5 things that start before 7:00", function(S){ return [S.early, 5]; }, "life"],
    ["early25", "dawn patrol", "finish 25 things that start before 7:00", function(S){ return [S.early, 25]; }, "life"],
    ["refl7", "know thyself", "write 7 reflections", function(S){ return [S.refl, 7]; }, "life"],
    ["refl30", "philosopher", "write 30 reflections", function(S){ return [S.refl, 30]; }, "life"],
    ["review4", "weekly reviewer", "write 4 weekly reviews", function(S){ return [S.reviews, 4]; }, "life"],
    ["claim1", "treat yourself", "claim your first reward", function(S){ return [S.claims, 1]; }, "life"],
    ["claim10", "earned it", "claim 10 rewards", function(S){ return [S.claims, 10]; }, "life"],
    // money & trackers: the rest of the site
    ["fin7", "bookkeeper", "log money on 7 days", function(S){ return [S.finDays, 7]; }, "money & trackers"],
    ["finrun14", "on the books", "log money 14 days in a row", function(S){ return [S.finRun, 14]; }, "money & trackers"],
    ["fin30", "tracked month", "log money on 30 days", function(S){ return [S.finDays, 30]; }, "money & trackers"],
    ["fin100", "ledger", "log money on 100 days", function(S){ return [S.finDays, 100]; }, "money & trackers"],
    ["tick50", "box ticker", "tick 50 tracker boxes yourself", function(S){ return [S.ticks, 50]; }, "money & trackers"],
    // hardcore: consistency and intensity, not just time
    ["deep1", "deep work", "4h+ of CWES and side hustle in one day", function(S){ return [S.deepDays, 1]; }, "hardcore"],
    ["deep10", "deep diver", "4h+ of CWES and side hustle on 10 days", function(S){ return [S.deepDays, 10]; }, "hardcore"],
    ["nozero30", "no zero days", "30 days in a row with 1h+ of CWES or side hustle (rest days skip)", function(S){ return [S.bestNZ, 30]; }, "hardcore"],
    ["nozero100", "relentless", "100 days in a row with 1h+ of CWES or side hustle", function(S){ return [S.bestNZ, 100]; }, "hardcore"],
    ["flawless1", "flawless week", "beat the boss and clear every day of the same week", function(S){ return [S.flawless, 1]; }, "hardcore"],
    ["flawless4", "flawless month", "4 flawless weeks", function(S){ return [S.flawless, 4]; }, "hardcore"],
    ["bossrun4", "boss rush", "beat the boss 4 weeks in a row", function(S){ return [S.bossRun, 4]; }, "hardcore"],
    ["bossrun12", "unstoppable", "beat the boss 12 weeks in a row", function(S){ return [S.bossRun, 12]; }, "hardcore"],
    ["raid1", "raider", "beat a raid boss (every 4th week, 150% of your targets)", function(S){ return [S.raids, 1]; }, "hardcore"],
    ["raid10", "raid leader", "beat 10 raid bosses", function(S){ return [S.raids, 10]; }, "hardcore"],
    ["gymrun8", "iron months", "hit your gym target 8 weeks in a row", function(S){ return [S.gymRun, 8]; }, "hardcore"],
    ["elite25", "elite", "finish 25 elite quests", function(S){ return [S.eliteN, 25]; }, "hardcore"],
    ["comeback", "comeback kid", "lose a run of 7+ cleared days, then build a new one of 14+", function(S){ return [S.comeback ? 1 : 0, 1]; }, "hardcore"],
    ["crit200", "loaded dice", "land 200 crits", function(S){ return [S.critN, 200]; }, "hardcore"],
    ["sidemonth50", "hustle month", "50h on the side hustle in one month", function(S){ return [S.bestSideMonth / 60, 50, "h"]; }, "hardcore"],
    ["money100", "closer", "100h of marketing or selling", function(S){ return [S.money / 60, 100, "h"]; }, "hardcore"],
    ["early30", "5am club", "finish something that starts before 5:30 on 30 days", function(S){ return [S.early530, 30]; }, "hardcore"],
    ["day1000", "god mode", "earn 1,000 xp in one day", function(S){ return [S.bestDay, 1000, " xp"]; }, "hardcore"],
    ["triple30", "quest god", "finish all 3 quests on 30 days", function(S){ return [S.tripleN, 30]; }, "hardcore"],
    ["xp100k", "six figures", "earn 100,000 xp", function(S){ return [S.xp, 100000, " xp"]; }, "hardcore"],
    ["perfect12", "perfectionist", "12 perfect weeks", function(S){ return [S.fullWeeks, 12]; }, "hardcore"],
    ["streak180", "unbreakable", "180 cleared days in a row", function(S){ return [S.best, 180]; }, "hardcore"],
    ["streak365", "the 365", "365 cleared days in a row", function(S){ return [S.best, 365]; }, "hardcore"],
    ["cwes500", "exploit dev", "500h of CWES study", function(S){ return [S.cwes / 60, 500, "h"]; }, "hardcore"],
    ["focus1000", "a thousand hours", "1,000h of CWES and side hustle", function(S){ return [(S.cwes + S.side) / 60, 1000, "h"]; }, "hardcore"],
    ["lvl150", "level 150", "reach level 150", function(S){ return [S.level, 150]; }, "hardcore"]
  ];
  var ICON = {
    first:"bloody-sword",
    clear1:"checked-shield",
    streak3:"flame",
    streak7:"fluffy-flame",
    streak21:"flame-spin",
    streak66:"dna2",
    streak100:"crowned-skull",
    clear30:"calendar",
    clear100:"star-medal",
    clear365:"aztec-calendar-sun",
    perfect:"laurels",
    perfect4:"laurels-trophy",
    cwes10:"keyboard",
    cwes50:"spotted-bug",
    cwes100:"spider-web",
    cwes250:"death-skull",
    lab10:"bubbling-flask",
    lab50:"broken-skull",
    rev10:"open-book",
    side10:"claw-hammer",
    side50:"gears",
    side100:"rocket-flight",
    side250:"castle",
    money5:"coins",
    money20:"money-stack",
    idea10:"light-bulb",
    gymweek:"weight-lifting-up",
    gymweek4:"muscle-up",
    gymweek12:"fist",
    gym25:"running-shoe",
    gym50:"anvil",
    gym100:"mailed-fist",
    quest10:"scroll-unfurled",
    quest100:"tied-scroll",
    triple1:"bullseye",
    triple10:"target-arrows",
    boss1:"crossed-swords",
    boss4:"bordered-shield",
    boss12:"dragon-head",
    boss52:"spiked-dragon-head",
    crit10:"dice-twenty-faces-twenty",
    crit50:"dice-fire",
    day300:"heavy-lightning",
    day500:"burning-skull",
    xp10k:"gems",
    lvl5:"rank-1",
    lvl10:"rank-2",
    lvl25:"rank-3",
    lvl50:"diamond-trophy",
    lvl100:"imperial-crown",
    early5:"sunrise",
    early25:"sun",
    refl7:"meditation",
    refl30:"brain",
    review4:"notebook",
    claim1:"present",
    claim10:"trophy-cup",
    deep1:"brainstorm", deep10:"brain-tentacle", nozero30:"focused-lightning", nozero100:"lightning-dome",
    flawless1:"sport-medal", flawless4:"medallist", bossrun4:"warhammer", bossrun12:"thor-hammer", raid1:"evil-tower", raid10:"grim-reaper",
    gymrun8:"weight-crush", elite25:"boss-key", comeback:"feathered-wing", crit200:"dice-eight-faces-eight", sidemonth50:"coins-pile",
    money100:"crown-coin", early30:"sunbeams", day1000:"crowned-explosion", triple30:"scroll-quill", xp100k:"fire-gem",
    perfect12:"crown-of-thorns", wq1:"checklist", wsweep1:"target-prize", wq25:"flying-target", wsweep10:"medal-skull", fin7:"two-coins", finrun14:"receive-money", fin30:"take-my-money", fin100:"coins-pile", tick50:"check-mark", streak180:"fire-ace", streak365:"over-infinity", cwes500:"daemon-skull", focus1000:"hourglass", lvl150:"falling-star"
  };
  var RARE = {
    streak7:2, clear30:2, perfect:2, cwes50:2, side50:2, money20:2, gymweek4:2, gym50:2, boss4:2, crit50:2, lvl10:2,
    early25:2, refl30:2, claim10:2, triple10:2, lab10:1,
    streak21:3, streak66:3, clear100:3, perfect4:3, cwes100:3, lab50:3, side100:3, gymweek12:3, gym100:3, quest100:3,
    boss12:3, day500:3, xp10k:3, lvl25:3,
    streak100:4, clear365:4, cwes250:4, side250:4, boss52:4, lvl50:4, lvl100:4,
    finrun14:2, fin30:2, tick50:2, fin100:3, wsweep1:2, wq25:3, wsweep10:4,
    deep1:3, flawless1:3, bossrun4:3, raid1:3, elite25:3, comeback:3, crit200:3,
    deep10:4, nozero30:4, flawless4:4, gymrun8:4, sidemonth50:4, money100:4, early30:4, day1000:4, triple30:4, xp100k:4,
    nozero100:5, bossrun12:5, raid10:5, perfect12:5, streak180:5, streak365:5, cwes500:5, focus1000:5, lvl150:5
  };
  function rankRarity(i){ return i < 2 ? 1 : i < 5 ? 2 : i < 8 ? 3 : i < 11 ? 4 : 5; }
  // a new rank every few levels
  var RANKS = [[1, "recruit", "rank-1"], [5, "initiate", "rank-2"], [10, "grinder", "rank-3"], [15, "specialist", "on-target"], [20, "veteran", "medal"], [25, "elite", "ribbon-medal"],
    [30, "master", "broadsword"], [40, "grandmaster", "all-seeing-eye"], [50, "legend", "laurel-crown"], [75, "mythic", "dragon-breath"], [100, "ascended", "jewel-crown"],
    [150, "immortal", "angel-wings"], [200, "godlike", "hand-of-god"]];
  function rankOf(L){ var r = RANKS[0]; RANKS.forEach(function(x){ if(L >= x[0]) r = x; }); return r; }
  // every 4th week is a raid: the boss needs 150% of every target, and pays 500 xp
  var RAIDS = ["the burnout titan", "procrastination prime", "the doom hydra", "the void lich", "the final boss"];
  function isRaid(mon){ return Math.floor(Math.round(pd(mon).getTime() / 864e5) / 7) % 4 === 3; }
  function bossOf(mon, w){
    var raid = isRaid(mon), need = raid ? 1.5 : 1;
    var parts = FOCUS.filter(function(a){ return P.areas[a].target > 0; });
    var max = parts.length * 100, dmg = 0;
    parts.forEach(function(a){ dmg += Math.min(1, actual(w, a) / (P.areas[a].target * need)) * 100; });
    var hp = Math.max(0, Math.round(max - dmg));
    var names = raid ? RAIDS : BOSSES;
    return { mon:mon, raid:raid, name:names[hash(mon) % names.length], max:max, hp:hp, dead:max > 0 && hp === 0 };
  }
  // this planner's share of the game; the main planner also brings the cleared-day streak,
  // quests and bosses (o.main). Other planners, trackers and money logging only add XP and stats.
  var finDays = null;   // dates with money logged, for the "log your money" quest
  function planParts(o){
    o = o || {};
    finDays = o.financeDays || null;
    var t = today(), events = [], S = { cwes:0, side:0, money:0, gymN:0, early:0, firstDone:false, labN:0, revN:0, ideaN:0, critN:0 };
    var focusDay = {}, sideMonth = {}, early530 = {};
    var gymDay = {}, first = null;
    P.acts.forEach(function(a){ if(!first || a.date < first) first = a.date; });
    P.acts.forEach(function(a){
      if(!a.done || notTask(a) || a.date > t) return;
      S.firstDone = true;
      var m = a.start != null ? Math.min(240, a.end - a.start) : 0, xp;
      if(a.area === "gym"){ xp = gymDay[a.date] ? 15 : 50; if(!gymDay[a.date]) S.gymN++; gymDay[a.date] = 1; }
      else if(a.area === "cwes" || a.area === "side") xp = m || 20;
      else if(a.area === "work") xp = m ? Math.round(m / 3) : 10;
      else xp = m ? Math.round(m / 6) : 10;
      xp += a.prio === 3 ? 15 : 0;
      var crit = hash(a.id) % 7 === 0;
      if(crit) xp *= 2;
      if(a.area === "cwes") S.cwes += m;
      if(a.area === "side"){ S.side += m; if(MONEY_SUBS.indexOf(a.sub) >= 0) S.money += m; }
      if(a.start != null && a.start >= DAWN && a.start < 420) S.early++;
      if(a.area === "cwes" && a.sub === "lab") S.labN++;
      if(a.area === "cwes" && a.sub === "revision") S.revN++;
      if(a.area === "side" && a.sub === "idea") S.ideaN++;
      if(crit) S.critN++;
      if(a.area === "cwes" || a.area === "side") focusDay[a.date] = (focusDay[a.date] || 0) + m;
      if(a.area === "side"){ var mk = a.date.slice(0, 7); sideMonth[mk] = (sideMonth[mk] || 0) + m; }
      if(a.start != null && a.start >= DAWN && a.start < 330) early530[a.date] = 1;
      events.push({ key:"a:" + a.id, date:a.date, xp:xp, label:a.title, crit:crit });
    });
    var out = { events:events, S:S, focusDay:focusDay, sideMonth:sideMonth, early530:early530,
      refl:Object.keys(P.reflect || {}).length, reviews:Object.keys(P.reviews || {}).length };
    if(!o.main) return out;
    // focus from every planner counts toward "no zero days"
    var fd = {};
    Object.keys(focusDay).forEach(function(k){ fd[k] = focusDay[k]; });
    if(o.focusExtra) Object.keys(o.focusExtra).forEach(function(k){ fd[k] = (fd[k] || 0) + o.focusExtra[k]; });
    out.focusAll = fd;
    // cleared days and the streak (rest days skip, today isn't over yet)
    var cleared = {}, run = 0, best = 0, clearN = 0, hadLong = false, comeback = false, nz = 0, bestNZ = 0;
    if(first && first < addDays(t, -800)) first = addDays(t, -800);
    if(first) for(var d = first; d <= t; d = addDays(d, 1)){
      if(P.rest[d]) continue;
      if(countsFor(P, itemsOn(d))){ cleared[d] = 1; clearN++; run++; events.push({ key:"c:" + d, date:d, xp:50, label:"cleared the day" }); }
      else if(d < t){ if(run >= 7) hadLong = true; run = 0; }
      if(hadLong && run >= 14) comeback = true;
      if(run > best) best = run;
      if((fd[d] || 0) >= 60) nz++; else if(d < t) nz = 0;
      if(nz > bestNZ) bestNZ = nz;
    }
    // quests: stored picks for past days, today's live until the first change saves them
    var todayQ = [], qFresh = { daily:false, weekly:false };
    var qDays = Object.keys(GM.quests); if(qDays.indexOf(t) < 0) qDays.push(t);
    qDays.forEach(function(d){
      if(d > t) return;
      var c = dayCtx(d), ids = GM.quests[d];
      if(ids && d === t && misfit(ids, ids.some(function(id){ var Q = resolveQ(id); if(!Q) return false; var pr = Q.prog(c); return pr[0] >= pr[1]; }))) ids = null;
      if(!ids){ ids = pickDaily(d, c); if(d === t) qFresh.daily = true; }
      ids.forEach(function(id){
        var Q = resolveQ(id); if(!Q) return;
        var pr = Q.prog(c), live = pr[0] >= pr[1], ok = live || (Q.keep && wonQ(d, id));
        if(ok && !live) pr = [pr[1], pr[1]];
        if(ok) events.push({ key:"q:" + d + ":" + id, date:d, xp:Q.xp, label:(Q.elite ? "elite quest: " : "quest: ") + Q.label, elite:Q.elite });
        if(d === t) todayQ.push({ id:id, label:Q.label, done:ok, live:live, keep:Q.keep, elite:Q.elite, xp:Q.xp, have:pr[0], need:pr[1], unit:Q.unit, tip:Q.tip,
          missed:!ok && Q.late > 0 && nowMin() >= Q.late });
      });
    });
    // weekly quests: stored picks for past weeks, this week's live until the first change saves them
    var weekQ = [], thisMon = wkStart(t);
    var wDays = Object.keys(GM.wquests || {}); if(wDays.indexOf(thisMon) < 0) wDays.push(thisMon);
    wDays.forEach(function(mon){
      if(mon > t) return;
      var wc = weekCtx(mon), ids = (GM.wquests || {})[mon];
      if(ids && mon === thisMon && misfit(ids, ids.some(function(id){ var Q = resolveQ(id); if(!Q) return false; var pr = Q.prog(wc); return pr[0] >= pr[1]; }))) ids = null;
      if(!ids){ ids = mon === thisMon ? pickWeekly(mon, wc) : []; if(mon === thisMon) qFresh.weekly = true; }
      var endD = addDays(mon, 6) < t ? addDays(mon, 6) : t, all = ids.length >= 3;
      var daysLeft = mon === thisMon ? Math.round((Date.parse(addDays(mon, 6)) - Date.parse(t)) / 864e5) + 1 : 0;
      ids.forEach(function(id){
        var Q = resolveQ(id); if(!Q) return;
        var pr = Q.prog(wc), ok = pr[0] >= pr[1];
        if(!ok) all = false;
        if(ok) events.push({ key:"W:" + mon + ":" + id, date:endD, xp:Q.xp, label:"weekly quest: " + Q.label, weekly:true });
        // a "on n days" quest is missed once the days left can't make it
        var left = daysLeft - (Q.lateDay && nowMin() >= Q.lateDay ? 1 : 0);
        if(mon === thisMon) weekQ.push({ id:id, label:Q.label, done:ok, xp:Q.xp, have:pr[0], need:pr[1], unit:Q.unit, tip:Q.tip,
          missed:!ok && Q.perDay && Math.floor(pr[0]) + left < pr[1] });
      });
      if(all) events.push({ key:"S:" + mon, date:endD, xp:100, label:"weekly sweep: all 3 weekly quests", sweep:true });
    });
    // weekly bosses (and gym-target weeks, perfect weeks)
    var bosses = 0, gymWeeks = 0, fullWeeks = 0, boss = null, curMon = wkStart(t);
    var raids = 0, flawless = 0, bRun = 0, bossRun = 0, gRun = 0, gymRun = 0;
    for(var mon = wkStart(first || t); mon <= curMon; mon = addDays(mon, 7)){
      var w = weekStats(mon), B = bossOf(mon, w), over = addDays(mon, 6) <= t;
      if(B.dead){
        bosses++; if(B.raid) raids++;
        events.push({ key:"b:" + mon, date:over ? addDays(mon, 6) : t, xp:B.raid ? 500 : 200, label:"beat " + B.name, raid:B.raid });
      }
      if(B.dead){ bRun++; if(bRun > bossRun) bossRun = bRun; } else if(over) bRun = 0;
      var gymMet = P.areas.gym.target > 0 && actual(w, "gym") >= P.areas.gym.target;
      if(gymMet){ gymWeeks++; gRun++; if(gRun > gymRun) gymRun = gRun; } else if(over) gRun = 0;
      if(over){
        var all = true;
        for(var k = 0; k < 7; k++){ var dk = addDays(mon, k); if(!P.rest[dk] && !cleared[dk]){ all = false; break; } }
        if(all) fullWeeks++;
        if(all && B.dead) flawless++;
      }
      if(mon === curMon) boss = B;
    }
    out.main = { cleared:cleared, run:run, best:best, clearN:clearN, comeback:comeback, bestNZ:bestNZ, todayQ:todayQ, weekQ:weekQ, qFresh:qFresh, boss:boss,
      thisMon:thisMon, qDate:t, qSig:(P.settings.questStyle || "flexible") + "/" + (P.settings.focus || "cwes"),
      bosses:bosses, raids:raids, flawless:flawless, bossRun:bossRun, gymRun:gymRun, gymWeeks:gymWeeks, fullWeeks:fullWeeks };
    return out;
  }
  // add everything up: the main planner's part, the other planners', trackers and money logging
  function finish(mainPart, others, extra){
    extra = extra || { events:[] };
    var M = mainPart.main, S = {}, events = mainPart.events.slice(), focus = {}, sideMonth = {}, early530 = {};
    ["cwes", "side", "money", "gymN", "early", "labN", "revN", "ideaN", "critN"].forEach(function(k){ S[k] = 0; });
    S.firstDone = false; S.refl = 0; S.reviews = 0;
    [mainPart].concat(others).forEach(function(part, i){
      if(i) events = events.concat(part.events);
      Object.keys(S).forEach(function(k){ if(typeof part.S[k] === "number") S[k] += part.S[k]; });
      if(part.S.firstDone) S.firstDone = true;
      S.refl += part.refl; S.reviews += part.reviews;
      Object.keys(part.sideMonth).forEach(function(k){ sideMonth[k] = (sideMonth[k] || 0) + part.sideMonth[k]; });
      Object.keys(part.early530).forEach(function(k){ early530[k] = 1; });
    });
    focus = mainPart.focusAll || mainPart.focusDay;
    events = events.concat(extra.events || []);
    S.raids = M.raids; S.flawless = M.flawless; S.bossRun = M.bossRun; S.gymRun = M.gymRun; S.comeback = M.comeback; S.bestNZ = M.bestNZ;
    S.deepDays = Object.keys(focus).filter(function(k){ return focus[k] >= 240; }).length;
    S.early530 = Object.keys(early530).length;
    S.bestSideMonth = 0; Object.keys(sideMonth).forEach(function(k){ if(sideMonth[k] > S.bestSideMonth) S.bestSideMonth = sideMonth[k]; });
    S.eliteN = events.filter(function(e){ return e.elite; }).length;
    S.finDays = extra.finDays || 0; S.finRun = extra.finRun || 0; S.ticks = extra.ticks || 0;
    var xp = 0; events.forEach(function(e){ xp += e.xp; });
    var level = levelOf(xp);
    S.clearN = M.clearN; S.best = M.best; S.bosses = M.bosses; S.gymWeeks = M.gymWeeks; S.fullWeeks = M.fullWeeks;
    S.level = level; S.xp = xp; S.claims = GM.claims.length;
    var perDay = {}, qDay = {};
    events.forEach(function(e){
      if(!e.date) return;
      perDay[e.date] = (perDay[e.date] || 0) + e.xp;
      if(e.key.charAt(0) === "q"){ qDay[e.date] = (qDay[e.date] || 0) + 1; }
    });
    S.bestDay = 0; Object.keys(perDay).forEach(function(d){ if(perDay[d] > S.bestDay) S.bestDay = perDay[d]; });
    S.questN = 0; S.tripleN = 0; Object.keys(qDay).forEach(function(d){ S.questN += qDay[d]; if(qDay[d] >= 3) S.tripleN++; });
    S.weeklyN = events.filter(function(e){ return e.weekly; }).length;
    S.sweepN = events.filter(function(e){ return e.sweep; }).length;
    var ach = ACH.map(function(A){ var pr = A[3](S); return { id:A[0], name:A[1], desc:A[2], have:pr[0], need:pr[1], unit:pr[2] || "", got:pr[0] >= pr[1], group:A[4], icon:ICON[A[0]] || "star-medal", rarity:RARE[A[0]] || 1 }; });
    var keys = {}; events.forEach(function(e){ keys[e.key] = e; });
    var spent = 0; GM.claims.forEach(function(c){ spent += c.cost; });
    var badgeCoins = 25 * ach.filter(function(x){ return x.got; }).length;
    var nextBadge = ach.filter(function(x){ return !x.got && x.have > 0; })
      .sort(function(x, y){ return y.have / y.need - x.have / x.need; })[0] || null;
    var rank = rankOf(level);
    return { xp:xp, level:level, base:lvlBase(level), next:lvlBase(level + 1), rank:rank, rankR:rankRarity(RANKS.indexOf(rank)), events:events, keys:keys, S:S, ach:ach,
             todayQ:M.todayQ, weekQ:M.weekQ || [], qFresh:M.qFresh || {}, thisMon:M.thisMon, qDate:M.qDate, qSig:M.qSig, boss:M.boss, streak:M.run, best:M.best, cleared:M.cleared, nextBadge:nextBadge,
             earned:Math.floor(xp / 10) + badgeCoins, spent:spent, coins:Math.floor(xp / 10) + badgeCoins - spent };
  }
  // the whole site's game (index.html passes ctx.score); on its own a planner scores just itself
  function computeGame(){
    if(ctx.score){ var G = ctx.score(); if(G) return G; }
    return finish(planParts({ main:true }), [], null);
  }
  var curG = null;
  // after each change: remember today's quests, note level and badges, toast what's new
  function fx(kind){ if(GM.loud && !GM.mute) sound(kind); }
  // the big moments get a full-screen card in loud mode, a toast in subtle mode
  function celebrate(kind, title, name, sub, icon){
    if(GM.loud){ bigCard(title, name, sub, icon); confetti(kind === "level" || kind === "boss" || kind === "reward" ? 90 : 40); fx(kind); }
    else toast(title + (name ? ": " + name : ""), sub);
  }
  function gameStep(){
    buildIndex();
    var before = curG, G = computeGame(), g = GM, t = today();
    var lk = lockQuests(g, G);
    // a kept quest that was already won before this change stays won, whatever the change did
    if(before && before.qDate === t && before.todayQ){
      var saved = g.quests[t] || [], wl = g.qwon[t] || [];
      before.todayQ.forEach(function(q){ if(q.keep && q.live && saved.indexOf(q.id) >= 0 && wl.indexOf(q.id) < 0){ wl.push(q.id); lk.picks = true; } });
      if(wl.length) g.qwon[t] = wl;
    }
    if(lk.picks){ G = computeGame(); lockQuests(g, G); }
    var fresh = !g.level;
    if(!fresh && !g.off && before){
      var gain = 0, crit = false, labels = [], big = null, quests = [], wqs = [], sweep = null;
      G.events.forEach(function(e){
        if(before.keys[e.key]) return;
        gain += e.xp; if(e.crit) crit = true;
        if(e.key.charAt(0) === "q") quests.push(e);
        else if(e.key.charAt(0) === "W") wqs.push(e);
        else if(e.key.charAt(0) === "S") sweep = e;
        else if(e.key.charAt(0) === "b") big = e.raid ? ["boss", "raid boss defeated", e.label.replace(/^beat /, ""), "+500 xp · +50 coins", { icon:"overlord-helm", r:5 }]
          : ["boss", "boss defeated", e.label.replace(/^beat /, ""), "+200 xp · +20 coins", "crossed-swords"];
        else labels.push(e.label);
      });
      if(gain > 0 && labels.length){ toast("+" + gain + " xp" + (crit ? " · crit ×2" : ""), labels.slice(0, 2).join(", ")); fx(crit ? "badge" : "xp"); }
      quests.forEach(function(q){ toast(q.elite ? "elite quest done" : "quest done", q.label.replace(/^(elite )?quest: /, "") + " · +" + q.xp + " xp"); });
      if(quests.length){ fx("quest"); if(GM.loud) confetti(30); }
      wqs.forEach(function(q){ toast("weekly quest done", q.label.replace(/^weekly quest: /, "") + " · +" + q.xp + " xp"); });
      if(wqs.length){ fx("badge"); if(GM.loud) confetti(50); }
      if(sweep && !big) big = ["boss", "weekly sweep", "all 3 weekly quests", "+100 xp bonus", { icon:"medal-skull", r:4 }];
      var quiet = (g.achv || 1) < ACH_VERSION;
      var badges = quiet ? [] : G.ach.filter(function(a){ return a.got && !g.seen[a.id]; });
      badges.forEach(function(a){ toast("unlocked: " + a.name, a.desc + " · +25 coins"); });
      if(badges.length){ fx("badge"); if(GM.loud) confetti(45); }
      var newRank = G.level > g.level && rankOf(G.level)[0] > rankOf(g.level)[0];
      if(newRank) big = ["level", "new rank", rankOf(G.level)[1], "level " + G.level + " · " + G.coins + " coins to spend", { icon:rankOf(G.level)[2], r:rankRarity(RANKS.indexOf(rankOf(G.level))) }];
      else if(G.level > g.level && !big) big = ["level", "level " + G.level, rankOf(G.level)[1], "next level at " + G.next + " xp · " + G.coins + " coins to spend", rankOf(G.level)[2]];
      else if(!big && badges.length){
        var top = badges.slice().sort(function(x, y){ return y.rarity - x.rarity; })[0];
        big = ["badge", RARITY_NAME[top.rarity] + " badge unlocked", top.name + (badges.length > 1 ? " +" + (badges.length - 1) + " more" : ""), top.desc + " · +25 coins", { icon:top.icon, r:top.rarity }];
      }
      else if(G.level > g.level) toast("level " + G.level, "next at " + G.next + " xp");
      if(big) celebrate(big[0], big[1], big[2], big[3], big[4]);
    }
    g.level = G.level;
    G.ach.forEach(function(a){ if(a.got && !g.seen[a.id]) g.seen[a.id] = t; });
    g.achv = ACH_VERSION;
    var moved = !before || before.xp !== G.xp;
    curG = G;
    return moved;
  }
  // redraw just the header (typing elsewhere keeps its focus)
  function repaintDash(){
    var old = root.querySelector(".pl-dash");
    if(old && old.parentNode) old.parentNode.replaceChild(dashboard(), old);
  }
  // ===== SHORTCUTS: keys on a keyboard, buttons in the "keys" panel =====
  function goTab(v){ u.view = v; u.tplSave = false; u.flash = ""; u.keys = false; draw(); }
  function stepSize(){ return (u.view === "week" || u.view === "focus") ? 7 : 1; }
  var KEYS = [
    ["q", "log something", function(){ u.keys = false; draw(); var qi = root.querySelector(".pl-qin"); if(qi) qi.focus(); }],
    ["n", "new activity", function(){ u.keys = false; openNew({ date:u.date }); }],
    ["p", "plan the day", function(){ u.keys = false; u.view = "day"; u.planDay = true; draw(); var x = root.querySelector(".pl-plan"); if(x) x.focus(); }],
    ["d", "day", function(){ goTab("day"); }],
    ["w", "week", function(){ goTab("week"); }],
    ["a", "areas", function(){ goTab("focus"); }],
    ["g", "game page", function(){ u.keys = false; if(ctx.openGame) ctx.openGame(); }],
    ["s", "settings", function(){ goTab("settings"); }],
    ["t", "today", function(){ u.keys = false; u.date = today(); if(u.view === "game" || u.view === "settings") u.view = "day"; draw(); }],
    ["[", "back", function(){ u.date = addDays(u.date, -stepSize()); draw(); }],
    ["]", "forward", function(){ u.date = addDays(u.date, stepSize()); draw(); }],
    ["?", "show or hide this list", function(){ u.keys = !u.keys; draw(); }]
  ];
  function keysPanel(){
    return h("div", { class:"pl-keys", role:"menu" }, KEYS.map(function(k){
      return h("button", { type:"button", class:"pl-key", role:"menuitem", onclick:function(){ k[2](); } },
        [ h("kbd", { text:k[0] }), h("span", { text:k[1] }) ]);
    }));
  }
  // what you're doing right now, big: a live countdown, done, timer, and what's next
  function dur(m){ m = Math.max(0, Math.round(m)); return m >= 60 ? Math.floor(m / 60) + "h " + pad(m % 60) + "m" : m + "m"; }
  function nowPanel(t){
    var nm = nowMin(), its = itemsOn(t).filter(function(it){ return it.start != null && !notTask(it) && !it.done; });
    var cur = its.filter(function(it){ return it.start <= nm && nm < it.end; })[0];
    var nxt = its.filter(function(it){ return it.start > nm; })[0];
    if(!cur && !nxt) return null;
    var then = nxt && cur ? h("small", { text:"then " + hm(nxt.start) + " " + nxt.title }) : null;
    if(!cur) return h("div", { class:"pl-now idle a-" + nxt.area }, [
      h("span", { class:"pl-nlab", text:"next" }), chk(nxt),
      h("button", { type:"button", class:"pl-nowt", onclick:function(){ u.view = "day"; u.date = t; openEdit(nxt); } }, [ nxt.title ]),
      h("span", { class:"pl-nowc", text:"in " + dur(nxt.start - nm) }),
      h("small", { text:hm(nxt.start) + "–" + hm(nxt.end) }) ]);
    var frac = (nm - cur.start) / (cur.end - cur.start);
    var timing = P.timer && P.timer.title === cur.title;
    return h("div", { class:"pl-now a-" + cur.area }, [
      h("div", { class:"pl-nowrow" }, [
        h("span", { class:"pl-nlab", text:"now" }),
        h("button", { type:"button", class:"pl-nowt", onclick:function(){ u.view = "day"; u.date = t; openEdit(cur); } }, [ cur.title ]),
        h("span", { class:"pl-nowc", text:dur(cur.end - nm) + " left" }) ]),
      h("span", { class:"pl-nowbar" }, [ h("i", { style:"width:" + Math.round(frac * 100) + "%" }) ]),
      h("div", { class:"pl-nowrow" }, [
        h("button", { type:"button", class:"pl-btn pl-primary", text:"✓ done", onclick:function(){ toggle(cur); } }),
        timing ? null : h("button", { type:"button", class:"pl-btn", text:"▶ timer", onclick:function(){
          if(P.timer) stopTimer(true);
          P.timer = normTimer({ title:cur.title, area:cur.area, sub:cur.sub, at:Date.now() });
          commit();
        } }),
        h("small", { text:hm(cur.start) + "–" + hm(cur.end) }), then ]) ]);
  }
  function xpRow(G){
    var span = G.next - G.base, into = G.xp - G.base;
    return h("div", { class:"pl-xprow", title:G.xp + " xp in total" }, [
      emb(G.rank[2], "pl-remb"),
      h("b", { text:"lvl " + G.level + " · " + G.rank[1] }),
      h("span", { class:"pl-xpbar" }, [ h("i", { style:"width:" + Math.round(into / span * 100) + "%" }) ]),
      h("small", { text:into + "/" + span + " xp" }),
      h("small", { class:"pl-coins", text:G.coins + " coins" }),
      GM.loud ? h("button", { type:"button", class:"pl-mute" + (GM.mute ? " off" : ""), "aria-pressed":GM.mute ? "false" : "true",
        title:GM.mute ? "sound off" : "sound on", text:"♪", onclick:function(){ GM.mute = !GM.mute; commit(); } }) : null ]);
  }
  function questRow(G){
    if(!G.todayQ.length) return null;
    return h("div", { class:"pl-next pl-quests" }, [ h("span", { class:"pl-nlab", text:"quests" }) ].concat(G.todayQ.map(function(q){
      var A = questAction(q);
      return h(A ? "button" : "span", { type:A ? "button" : null, class:"pl-quest" + (q.done ? " on" : "") + (q.elite ? " elite" : "") + (q.missed ? " missed" : "") + (A ? " go" : ""),
        title:(q.tip ? q.tip + "\n" : "") + (q.missed ? "missed: can't be done any more today" : A ? "click: " + A.label.replace("▶ ", "") : ""), onclick:A ? function(){ A.run(); } : null }, [ h("i", { text:q.done ? "✓" : "" }), q.label,
        !q.done && q.need > 1 ? h("small", { class:"pl-qprog", text:progText(q) }) : null, q.elite ? h("b", { class:"pl-etag", text:"elite" }) : null ]);
    })).concat(G.weekQ.length ? [ h("span", { class:"pl-qweek", title:G.weekQ.map(function(q){ return (q.done ? "✓ " : "· ") + q.label + " " + progText(q); }).join("\n") },
      [ "week " + G.weekQ.filter(function(q){ return q.done; }).length + "/" + G.weekQ.length ]) ] : []));
  }
  function bossCard(B){
    if(!B || !B.max) return null;
    return h("div", { class:"pl-boss" + (B.dead ? " dead" : "") + (B.raid ? " raid" : "") }, [
      h("span", { class:"pl-nlab", text:B.raid ? "raid boss" : "boss" }), h("b", { class:"pl-bname", text:B.name }),
      h("span", { class:"pl-hp", title:B.raid ? "a raid needs 150% of every weekly target" : "each weekly target is 100 hp" }, [ h("i", { style:"width:" + Math.round(B.hp / B.max * 100) + "%" }) ]),
      h("small", { text:B.dead ? "defeated · +" + (B.raid ? 500 : 200) + " xp" : B.hp + "/" + B.max + " hp" + (B.raid ? " · 150% targets" : "") }) ]);
  }
  // the reward shop: real things, priced in coins earned by finished work
  function shop(G){
    var rows = GM.rewards.map(function(r){
      var short_ = G.coins < r.cost;
      return h("div", { class:"pl-rw" }, [
        h("input", { class:"pl-in", type:"text", value:r.name, maxlength:"60", "aria-label":"reward",
          onchange:function(e){ var v = e.target.value.trim(); if(v){ r.name = v.slice(0, 60); } commit(); } }),
        h("input", { class:"pl-in pl-num", type:"number", min:"1", max:"100000", step:"10", value:String(r.cost), "aria-label":"price in coins",
          onchange:function(e){ var v = Math.round(+e.target.value); if(v >= 1 && v <= 100000) r.cost = v; commit(); } }),
        h("button", { type:"button", class:"pl-btn" + (short_ ? "" : " pl-primary"), disabled:short_ ? true : null,
          text:short_ ? (r.cost - G.coins) + " to go" : "claim",
          onclick:function(){
            if(G.coins < r.cost) return;
            GM.claims.push({ id:rid(), name:r.name, cost:r.cost, date:today() });
            commit();
            if(GM.loud){ bigCard("reward unlocked", r.name, "you earned it. go enjoy it.", "present"); confetti(110); fx("reward"); }
            else toast("reward unlocked: " + r.name, "you earned it");
          } }),
        armed(h("button", { type:"button", class:"pl-act", text:"×", "aria-label":"remove reward" }), "sure?", function(){
          GM.rewards.splice(GM.rewards.indexOf(r), 1); commit(); })
      ]);
    });
    var nm = h("input", { class:"pl-in", type:"text", placeholder:"add a reward you actually want", maxlength:"60", "aria-label":"new reward", "data-native-undo":"1",
      onkeydown:function(e){ if(e.key === "Enter"){ e.preventDefault(); addR(); } } });
    var pr = h("input", { class:"pl-in pl-num", type:"number", min:"1", max:"100000", step:"10", placeholder:"price", "aria-label":"price in coins", "data-native-undo":"1",
      onkeydown:function(e){ if(e.key === "Enter"){ e.preventDefault(); addR(); } } });
    function addR(){
      var v = nm.value.trim(), c = Math.round(+pr.value);
      if(!v){ nm.focus(); return; }
      if(!(c >= 1 && c <= 100000)){ pr.focus(); return; }
      GM.rewards.push({ id:rid(), name:v.slice(0, 60), cost:c }); commit();
    }
    rows.push(h("div", { class:"pl-rw" }, [ nm, pr, h("button", { type:"button", class:"pl-btn", text:"add", onclick:addR }) ]));
    var hist = GM.claims.slice(-6).reverse().map(function(c){
      return h("div", { class:"pl-xpline" }, [ h("small", { text:short(c.date).toLowerCase() }), h("span", { text:c.name }), h("b", { text:"−" + c.cost }) ]);
    });
    return section("rewards · " + G.coins + " coins", [ h("p", { class:"pl-hint", text:"1 coin per 10 xp. price things so they take real work: about 30 coins is a solid day." }) ]
      .concat(rows).concat(hist.length ? [ h("div", { class:"pl-claims" }, hist) ] : []));
  }
  // the last 12 months, one square a day, darker red for more xp
  function heatmap(G){
    var t = today(), byDay = {}, days = 0, bestDay = 0;
    G.events.forEach(function(e){ byDay[e.date] = (byDay[e.date] || 0) + e.xp; });
    Object.keys(byDay).forEach(function(k){ if(byDay[k] > 0){ days++; bestDay = Math.max(bestDay, byDay[k]); } });
    var last = wkStart(t), cols = [];
    for(var w = addDays(last, -52 * 7); w <= last; w = addDays(w, 7)){
      var col = h("div", { class:"pl-hcol" });
      for(var k = 0; k < 7; k++){
        var d = addDays(w, k), x = byDay[d] || 0;
        var lv = x <= 0 ? 0 : x < 100 ? 1 : x < 200 ? 2 : x < 350 ? 3 : 4;
        col.appendChild(h("i", { class:"l" + lv + (d === t ? " now" : "") + (d > t ? " fut" : ""), title:dayLabel(d).toLowerCase() + ": " + x + " xp" }));
      }
      cols.push(col);
    }
    var legend = h("div", { class:"pl-hleg" }, [ h("small", { text:days + " active days · best day " + bestDay + " xp" }),
      h("span", { class:"pl-hkey" }, [ "less", h("i", { class:"l0" }), h("i", { class:"l1" }), h("i", { class:"l2" }), h("i", { class:"l3" }), h("i", { class:"l4" }), "more" ]) ]);
    return section("last 12 months", [ h("div", { class:"pl-heat", role:"img", "aria-label":"xp per day over the last year" }, cols), legend ]);
  }
  // what pressing ▶ on a quest does: activity quests start the timer (stopping it logs the real
  // minutes, which then count), the rest open the place where they get done
  var CWES_Q = { cwesmin:1, cwessub:1, topic:1, early:1, deep:1, focusmin:1, cwesh:1, cwesdays:1, labs:1, rev:1, topicw:1, deepw:1, earlyw:1, nozerow:1,
                 cwes1:1, cwes60:1, e_cwes120:1, e_deep:1, e_early2:1, beat:1, cwesall:1, beatw:1 };
  function questKey(id){ var m = /^[dew]:([a-z0-9]+):(.*)$/.exec(id); return m ? [m[1], m[2]] : [id, ""]; }
  function questAction(q){
    var k = questKey(q.id), key = k[0], arg = k[1];
    if(q.done || q.missed) return null;
    var running = function(area){ return P.timer && P.timer.area === area ? { label:"timer on", run:function(){ u.view = "day"; u.date = today(); toPlanner(); } } : null; };
    if(CWES_Q[key]){
      var sub = "", title = "CWES study";
      if(key === "cwessub"){ sub = arg.split(".")[0]; title = "CWES " + sub; }
      if(key === "labs"){ sub = "lab"; title = "CWES lab"; }
      if(key === "rev"){ sub = "revision"; title = "CWES revision"; }
      if(key === "topic" || key === "topicw"){ var T = topicBy(arg.split(".")[0]); if(T) title = "CWES: " + T[2]; }
      if(key === "deep" || key === "deepw" || key === "e_deep") title = "CWES deep work";
      return running("cwes") || { label:"▶ start", run:function(){ startQuestTimer(title, "cwes", sub); } };
    }
    if(key === "gym" || key === "gymw") return running("gym") || { label:"▶ start", run:function(){ startQuestTimer("gym", "gym", ""); } };
    if(key === "side" || key === "sidew") return running("side") || { label:"▶ start", run:function(){ startQuestTimer("side hustle", "side", ""); } };
    if(key === "money" || key === "moneyw") return ctx.openFinance ? { label:"open money", run:function(){ ctx.openFinance(); } } : null;
    if(key === "plan") return { label:arg === "cwes" ? "plan it" : "plan tomorrow", run:function(){
      if(arg === "cwes"){ u.view = "day"; u.date = addDays(today(), 1); var dr = blankDraft(u.date); dr.area = "cwes"; u.form = { key:null, d:dr };
        toPlanner(function(){ var x = document.querySelector(".pl-ftitle"); if(x){ x.focus(); x.scrollIntoView({ block:"nearest" }); } }); }
      else { u.view = "day"; u.date = addDays(today(), 1); u.planDay = true; toPlanner(function(){ var x = document.querySelector(".pl-plan"); if(x) x.focus(); }); }
    } };
    if(key === "refl" || key === "reflw") return { label:"write it", run:function(){ u.view = "day"; u.date = today(); u.openRefl = true; toPlanner(); } };
    return { label:"open today", run:function(){ u.view = "day"; u.date = today(); toPlanner(); } };
  }
  function startQuestTimer(title, area, sub){
    if(P.timer) stopTimer(true);
    P.timer = normTimer({ title:title, area:area, sub:sub, at:Date.now() });
    u.view = "day"; u.date = today();
    commit();
    if(ctx.gameOnly && ctx.openPlanner) ctx.openPlanner();
  }
  // from the game page, actions happen in the Command Center
  function toPlanner(then){
    if(ctx.gameOnly){ if(ctx.openPlanner) ctx.openPlanner(then); }
    else { draw(); if(then) then(); }
  }
  // one quest as a row: tick, name, progress bar, xp
  function questLine(q){
    var A = questAction(q);
    return h("div", { class:"pl-quest pl-qline" + (q.done ? " on" : "") + (q.elite ? " elite" : "") + (q.missed ? " missed" : "") + (A ? " go" : ""),
      title:(q.tip || "") + (q.missed ? (q.tip ? "\n" : "") + "can't be done any more this " + (q.id.charAt(0) === "w" ? "week" : "day") : "") || null,
      onclick:A ? function(){ A.run(); } : null }, [
      h("i", { text:q.done ? "✓" : "" }), h("span", { class:"pl-qlabel", text:q.label }), q.elite ? h("b", { class:"pl-etag", text:"elite" }) : null,
      q.need > 1 || q.unit ? h("span", { class:"pl-qbar" }, [ h("i", { style:"width:" + Math.round(Math.min(1, q.have / q.need) * 100) + "%" }) ]) : null,
      q.need > 1 || q.unit ? h("small", { class:"pl-qprog", text:progText(q) }) : null,
      h("small", { text:"+" + q.xp + " xp" }),
      A ? h("button", { type:"button", class:"pl-qgo", text:A.label, onclick:function(e){ e.stopPropagation(); A.run(); } })
        : h("span", { class:"pl-qgo pl-qdone" + (q.missed ? " pl-qmiss" : ""), text:q.done ? "done" : q.missed ? "missed" : "" }) ]);
  }
  function gameSettings(){
    return section("game settings", [ h("label", { class:"pl-check pl-gamesw" }, [ h("input", { type:"checkbox", checked:GM.off ? null : true,
      onchange:function(e){ GM.off = !e.target.checked; commit(); } }), "xp, levels, quests, rewards and the weekly boss (one game for the whole site)" ]),
      GM.off ? null : h("div", { class:"pl-toggle pl-feel" }, [["loud", true], ["subtle", false]].map(function(m){
        return h("button", { type:"button", class:"pl-tog" + (GM.loud === m[1] ? " on" : ""), text:m[0], onclick:function(){ GM.loud = m[1]; commit(); } });
      })),
      GM.off || !GM.loud ? null : h("label", { class:"pl-check pl-gamesw" }, [ h("input", { type:"checkbox", checked:GM.mute ? null : true,
        onchange:function(e){ GM.mute = !e.target.checked; commit(); } }), "sound" ]) ]);
  }
  function gameView(){
    var G = curG;
    if(GM.off || !G){
      body.appendChild(h("p", { class:"pl-hint", text:"the game is off. turn it on below." }));
      body.appendChild(gameSettings());
      return;
    }
    var span = G.next - G.base, got = G.ach.filter(function(a){ return a.got; }).length;
    var nextRank = RANKS.filter(function(r){ return r[0] > G.level; })[0];
    // hero: the rank medallion, level, xp and the numbers that matter
    body.appendChild(h("div", { class:"pl-hero" }, [
      medal(G.rank[2], G.rankR, true, "pl-heromedal"),
      h("div", { class:"pl-herotxt" }, [
        h("div", { class:"pl-herolvl" }, [ h("b", { text:"lvl " + G.level }), h("span", { class:"pl-herorank", text:G.rank[1] }) ]),
        h("div", { class:"bar pl-herobar" }, [ h("i", { style:"width:" + Math.round((G.xp - G.base) / span * 100) + "%" }) ]),
        h("p", { class:"pl-hint", text:(G.next - G.xp) + " xp to level " + (G.level + 1) + (nextRank ? " · next rank " + nextRank[1] + " at level " + nextRank[0] : " · top rank") }),
        h("div", { class:"pl-herostats" }, [[G.xp, "xp"], [G.coins, "coins"], [got + "/" + G.ach.length, "badges"], [G.streak, "run"], [G.best, "best run"], [G.S.bosses, "bosses"]].map(function(x){
          return h("span", null, [ h("b", { text:String(x[0]) }), h("small", { text:x[1] }) ]);
        }))
      ])
    ]));
    body.appendChild(section("ranks", [ h("div", { class:"pl-ranks" }, RANKS.map(function(r){
        return h("span", { class:"pl-rank" + (G.level >= r[0] ? " got" : "") + (G.rank[0] === r[0] ? " cur" : ""), title:"from level " + r[0] }, [ medal(r[2], rankRarity(RANKS.indexOf(r)), G.level >= r[0]), h("b", { text:r[1] }), h("small", { text:"lvl " + r[0] }) ]);
      })),
      G.nextBadge ? h("p", { class:"pl-nextb" }, [ h("span", { class:"pl-nlab", text:"next badge" }), emb(G.nextBadge.icon), h("b", { text:G.nextBadge.name }),
        h("span", { text:Math.floor(G.nextBadge.have) + "/" + G.nextBadge.need + G.nextBadge.unit + " · " + G.nextBadge.desc }) ]) : null ]));
    var bc = bossCard(G.boss); if(bc) body.appendChild(section("this week", [ bc ]));
    if(G.todayQ.length) body.appendChild(section("today's quests", [ h("p", { class:"pl-hint pl-qhow",
      text:"quests tick themselves from what you finish in your Command Center. ▶ start runs the timer: stop it when you're done and the time counts. once done, a quest stays done." }) ]
      .concat(G.todayQ.map(questLine))));
    if(G.weekQ.length) body.appendChild(section("this week's quests · all 3 = +100 bonus", G.weekQ.map(questLine)));
    body.appendChild(shop(G));
    body.appendChild(section("badges " + got + "/" + G.ach.length + " · +25 coins each", ACH_GROUPS.map(function(grp){
      var list = G.ach.filter(function(a){ return a.group === grp; });
      var n = list.filter(function(a){ return a.got; }).length;
      return h("div", { class:"pl-bgroup" }, [ h("div", { class:"pl-bghead" }, [ h("span", { text:grp }), h("small", { text:n + "/" + list.length }) ]),
        h("div", { class:"pl-badges" }, list.map(function(a){
          var prog = a.got ? (GM.seen[a.id] ? short(GM.seen[a.id]).toLowerCase() : "") : Math.floor(Math.min(a.have, a.need)) + "/" + a.need + a.unit;
          return h("div", { class:"cell pl-badge r" + a.rarity + (a.got ? " done" : ""), title:a.desc }, [ medal(a.icon, a.rarity, a.got),
            h("b", { text:a.name }), h("span", { class:"pl-rar", text:RARITY_NAME[a.rarity] }), h("small", { text:prog }),
            a.got ? null : h("i", { class:"pl-bprog", style:"width:" + Math.round(Math.min(1, a.have / a.need) * 100) + "%" }) ]);
        })) ]);
    })));
    body.appendChild(heatmap(G));
    var recent = G.events.filter(function(e){ return e.date; }).sort(function(a, b){ return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }).slice(0, 12);
    if(recent.length) body.appendChild(section("recent xp", recent.map(function(e){
      return h("div", { class:"pl-xpline" }, [ h("small", { text:short(e.date).toLowerCase() }), h("span", { text:e.label }),
        h("b", { text:"+" + e.xp + (e.crit ? " crit" : "") }) ]);
    })));
    body.appendChild(gameSettings());
    body.appendChild(h("p", { class:"pl-credit" }, [ "badge icons from ", h("a", { href:"https://game-icons.net", target:"_blank", rel:"noopener", text:"game-icons.net" }),
      " by Lorc, Delapouite and contributors, ", h("a", { href:"https://creativecommons.org/licenses/by/3.0/", target:"_blank", rel:"noopener", text:"CC BY 3.0" }) ]));
  }

  function weekStats(mon){
    var w = { area:{}, days:[] };
    AREAS.forEach(function(a){ w.area[a] = { sched:0, done:0, count:0, doneCount:0, days:{}, doneDays:{}, subs:{} }; });
    for(var k = 0; k < 7; k++){
      var d = addDays(mon, k), day = { date:d, total:0, done:0, sched:0 };
      itemsOn(d).forEach(function(it){
        if(notTask(it)) return;
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
  var drawnOn = "";
  // a new day while the page is open: redraw (unless you're typing), so quests and "today" move on
  function dayTurned(){
    if(today() === drawnOn || (document.activeElement && root.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) return false;
    if(u.date === drawnOn) u.date = today();
    draw();
    return true;
  }
  function draw(){
    buildIndex();
    curG = computeGame();
    drawnOn = today();
    if(!GM.off) noteShown(curG);
    if(ctx.gameOnly){
      if(timerTick){ clearInterval(timerTick); timerTick = null; }
      if(nowTick){ clearInterval(nowTick); nowTick = null; }
      nowTick = setInterval(function(){
        if(!root.isConnected){ clearInterval(nowTick); nowTick = null; return; }
        dayTurned();
      }, 60000);
      root.innerHTML = "";
      body = h("div", { class:"pl-body pl-gamepage" });
      root.appendChild(body);
      gameView();
      return;
    }
    if(u.form && u.form.key && !(u.form.key.slice(0, 2) === "r:" ? ruleById(u.form.key.slice(2)) : findItem(u.form.key))) u.form = null;
    root.innerHTML = "";
    if(timerTick){ clearInterval(timerTick); timerTick = null; }
    if(nowTick){ clearInterval(nowTick); nowTick = null; }
    nowTick = setInterval(function(){
      if(!root.isConnected){ clearInterval(nowTick); nowTick = null; return; }
      if(root.offsetParent !== null && !dayTurned()) repaintDash();
    }, 30000);
    root.appendChild(dashboard());
    root.appendChild(quickBar());
    root.appendChild(toolbar());
    if(u.keys) root.appendChild(keysPanel());
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
    var t = today(), w = weekStats(wkStart(t)), td = dayStat(t), od = overdueList(t).length, L = linked();
    var right = ["gym", "cwes", "side"].map(function(a){
      var A = P.areas[a], v = actual(w, a), hrsUnit = A.unit === "h";
      var txt = hrsUnit ? num(v) + (A.target ? "/" + num(A.target) : "") + "h" : Math.round(v) + (A.target ? "/" + A.target : "");
      return h("span", null, [ A.name.split(" ")[0] + " ", h("b", { text:txt }) ]);
    });
    if(L) right.push(h("button", { type:"button", class:"pl-slink", title:"kept on “" + L.title + "”", onclick:function(){ u.view = "settings"; draw(); } },
      [ "streak ", h("b", { text:String(L.cur) }) ]));
    else right.push(h("button", { type:"button", class:"pl-slink pl-red", text:"link a streak", onclick:function(){ u.view = "settings"; draw(); } }));
    if(od) right.push(h("span", { class:"pl-red", text:od + " overdue" }));
    var pct = td.total ? Math.round(td.done / td.total * 100) : 0;
    var head = h("div", { class:"stats pl-stats" }, [
      h("span", { class:"count" }, [ h("b", { text:String(td.done) }), " / " + td.total, h("small", { class:"pl-cnt", text:"today" }) ]),
      h("span", { class:"right" }, right) ]);
    var bar = h("div", { class:"bar pl-dbar" }, [ h("i", { style:"width:" + pct + "%" }) ]);
    // the week as seven boxes: solid red once a day is done
    var week = h("div", { class:"pl-wk" }, w.days.map(function(d){
      var full = d.total > 0 && countsFor(P, itemsOn(d.date));
      return h("button", { type:"button", class:"cell pl-wkc" + (full ? " done" : "") + (d.date === t ? " today" : "") + (u.view === "day" && d.date === u.date ? " sel" : ""),
        title:dayLabel(d.date) + ": " + d.done + "/" + d.total + " done", onclick:function(){ u.view = "day"; u.date = d.date; draw(); } },
        [ h("b", { text:DOW[wd(d.date)] }), h("span", { text:d.total ? d.done + "/" + d.total : "·" }),
          d.total && !full && d.done ? h("i", { class:"pl-wkp", style:"width:" + Math.round(d.done / d.total * 100) + "%" }) : null ]);
    }));
    var nowP = nowPanel(t);
    var now = nowMin(), next = itemsOn(t).filter(function(it){ return it.start != null && !it.done && !isFlex(it) && it.end > now; }).slice(0, 3);
    var later = false;
    if(!next.length){ next = itemsOn(addDays(t, 1)).filter(function(it){ return it.start != null && !isFlex(it); }).slice(0, 3); later = true; }
    var nextEl = h("div", { class:"pl-next" }, [ h("span", { class:"pl-nlab", text:later ? "tomorrow" : "next" }) ].concat(next.length ? next.map(function(it){
      return h("span", { class:"pl-nextwrap" }, [ chk(it),
        h("button", { type:"button", class:"pl-nextit", onclick:function(){ u.view = "day"; u.date = it.date; openEdit(it); } }, [ hm(it.start) + " " + it.title ]) ]);
    }) : [ h("span", { class:"pl-lmuted", text:"nothing planned" }) ]));
    var on = !GM.off && curG;
    return h("div", { class:"pl-dash" }, [ head, bar, on ? xpRow(curG) : null, week, nowP || nextEl, on ? questRow(curG) : null ]);
  }

  // ===== QUICK LOG + TIMER =====
  // logging something you had planned ticks that block instead of adding a copy
  function matchPlanned(q){
    if(!q.done) return null;
    var c = itemsOn(q.date).filter(function(it){
      return !it.done && !notTask(it) && it.area === q.area && (!q.sub || !it.sub || it.sub === q.sub);
    });
    if(!c.length) return null;
    if(q.hadTime){
      var ov = c.filter(function(it){ return it.start != null && it.start < q.end && q.start < it.end; });
      return ov[0] || null;
    }
    return c[0];
  }
  function logQuick(q){
    var m = matchPlanned(q), a;
    if(m){
      a = materialize(m); a.done = true;
      if(q.hadTime || a.start == null){ a.start = q.start; a.end = q.end; }
      else if(q.dur) a.end = Math.min(1440, a.start + q.dur);
      if(!q.autoTitle && q.title !== a.title) a.notes = (a.notes ? a.notes + "\n" : "") + q.title;
    }else{
      a = { id:rid(), date:q.date, done:q.done, createdAt:Date.now() };
      setFields(a, normFields({}, q));
      P.acts.push(a);
    }
    return { act:a, matched:!!m };
  }
  function describe(q){
    var m = matchPlanned(q), bits = [];
    bits.push(q.area === "personal" ? "personal" : P.areas[q.area].name);
    if(q.sub) bits.push(q.sub);
    bits.push(q.date === today() ? "today" : dayLabel(q.date).toLowerCase());
    // show the times it will really get
    var s0 = q.start, e0 = q.end;
    if(m && !q.hadTime && m.start != null){ s0 = m.start; e0 = q.dur ? Math.min(1440, m.start + q.dur) : m.end; }
    bits.push(q.allDay ? "all day" : s0 != null ? hm(s0) + "–" + hm(e0) + (q.guessed ? " (read as pm)" : "") : "no time");
    var how = m ? "✓ ticks your planned " + (m.start != null ? hm(m.start) + " " : "") + m.title : q.done ? "✓ logged as done" : "planned";
    return { line:bits.join(" · "), title:q.title, how:how, matched:!!m };
  }
  function quickBar(){
    var wrap = h("div", { class:"pl-quick" });
    if(P.timer){
      var T0 = P.timer, clockEl = h("span", { class:"pl-tclock" });
      var paint = function(){
        var sec = Math.max(0, Math.floor((Date.now() - T0.at) / 1000));
        clockEl.textContent = pad(Math.floor(sec / 3600)) + ":" + pad(Math.floor(sec / 60) % 60) + ":" + pad(sec % 60);
      };
      paint(); timerTick = setInterval(paint, 1000);
      wrap.appendChild(h("div", { class:"pl-timer", role:"timer" }, [ h("i", { class:"pl-tdot" }), clockEl,
        h("span", { class:"pl-tttl", title:areaName(T0.area) + (T0.sub ? ", " + T0.sub : ""), text:T0.title }),
        h("button", { type:"button", class:"pl-btn pl-primary", text:"stop & log", onclick:stopTimer }),
        armed(h("button", { type:"button", class:"pl-btn pl-ghost", text:"discard" }), "sure?", function(){ P.timer = null; commit(); })
      ]));
    }
    var prev = h("div", { class:"pl-qprev", "aria-live":"polite" });
    var input = h("input", { type:"text", class:"pl-in pl-qin", maxlength:"160", value:u.qtext || "", "aria-label":"log or plan something",
      placeholder:"log or plan, e.g. gym 1h or cwes lab 18:00-19:30",
      oninput:function(){ u.qtext = input.value; u.qflash = ""; paintPrev(); },
      onkeydown:function(e){
        if(e.key === "Enter"){ e.preventDefault(); submit(); }
        else if(e.key === "Escape"){ input.value = ""; u.qtext = ""; paintPrev(); }
      } });
    function parsed(){ return parseQuick(input.value, P, u.view === "day" ? u.date : today(), nowMin()); }
    function paintPrev(){
      var q = parsed();
      prev.innerHTML = "";
      if(!q){ prev.textContent = u.qflash || ""; return; }
      var dsc = describe(q);
      prev.appendChild(h("b", { text:dsc.title }));
      prev.appendChild(document.createTextNode(" · " + dsc.line + " · "));
      prev.appendChild(h("span", { class:dsc.matched || q.done ? "pl-streak" : "", text:dsc.how }));
    }
    function submit(){
      var q = parsed();
      if(!q) return;
      var dsc = describe(q), r = logQuick(q);
      u.qtext = "";
      u.qflash = (r.matched ? "ticked: " + r.act.title : (q.done ? "logged: " : "planned: ") + q.title) + " · " + dsc.line + " · ctrl+z undoes it";
      commit();
      var n = root.querySelector(".pl-qin"); if(n) n.focus();
    }
    var startBtn = h("button", { type:"button", class:"pl-btn", text:P.timer ? "▶ switch" : "▶ timer",
      title:"start a timer for what you typed (or a focus session); stopping it logs the real time",
      onclick:function(){
        if(P.timer) stopTimer(true);
        var q = parseQuick(input.value || "", P, today(), nowMin());
        P.timer = normTimer({ title:q ? q.title : "focus session", area:q ? q.area : "personal", sub:q ? q.sub : "", at:Date.now() });
        u.qtext = ""; u.qflash = "timer started";
        commit();
      } });
    wrap.appendChild(h("div", { class:"pl-qrow" }, [ input, startBtn ]));
    wrap.appendChild(prev);
    paintPrev();
    return wrap;
  }
  // stopping logs the real time (ticking a planned block of the same area if they overlap)
  function stopTimer(quiet){
    var T0 = P.timer;
    if(!T0) return;
    var a0 = new Date(T0.at), now = new Date(), date = ds(a0), nowD = ds(now);
    var st = a0.getHours() * 60 + a0.getMinutes(), nowM = now.getHours() * 60 + now.getMinutes();
    var piece = function(d, s0, e0){
      if(e0 <= s0) e0 = Math.min(1440, s0 + 1);
      return logQuick({ title:T0.title, autoTitle:false, area:T0.area, sub:T0.sub, date:d, start:s0, end:e0, dur:e0 - s0, done:true, prio:0, hadTime:true });
    };
    var r, mins;
    // a session past midnight is split: the part before midnight stays on its own day, the rest counts for today
    if(nowD !== date && nowD === addDays(date, 1) && nowM > 0){ piece(date, st, 1440); r = piece(nowD, 0, nowM); mins = 1440 - st + nowM; }
    else { var en = nowD === date ? nowM : 1440; r = piece(date, st, en); mins = Math.max(1, en - st); }
    P.timer = null;
    u.qflash = "logged " + hrs(mins) + (mins < 60 ? " (" + mins + "m)" : "") + ": " + r.act.title + (r.matched ? " (ticked the planned block)" : "");
    if(quiet !== true) commit();
  }

  // ===== TOOLBAR =====
  function toolbar(){
    var t = today(), isWeek = u.view === "week" || u.view === "focus";
    var step = isWeek ? 7 : 1, label, isNow;
    if(isWeek){
      var m = wkStart(u.date), e = addDays(m, 6);
      label = short(m) + " – " + short(e) + (m.slice(0, 4) !== t.slice(0, 4) ? " " + m.slice(0, 4) : "");
      isNow = m === wkStart(t);
    }else{ label = dayLabel(u.date); isNow = u.date === t; }
    var nav = (u.view === "settings" || u.view === "game") ? null : h("div", { class:"pl-navrow" }, [
      h("button", { type:"button", class:"pl-nav", "aria-label":isWeek ? "previous week" : "previous day", text:"‹",
        onclick:function(){ u.date = addDays(u.date, -step); draw(); } }),
      h("span", { class:"pl-navlabel" + (isNow ? " now" : ""), text:label }),
      h("button", { type:"button", class:"pl-nav", "aria-label":isWeek ? "next week" : "next day", text:"›",
        onclick:function(){ u.date = addDays(u.date, step); draw(); } }),
      isNow ? null : h("button", { type:"button", class:"pl-link", text:isWeek ? "this week" : "today",
        onclick:function(){ u.date = t; draw(); } })
    ]);
    return h("div", { class:"pl-bar" }, [ nav,
      h("div", { class:"pl-tabs", role:"tablist" }, [["day", "day"], ["week", "week"], ["focus", "areas"], ["settings", "settings"]].map(function(v){
        return h("button", { type:"button", role:"tab", class:"pl-tab" + (u.view === v[0] ? " on" : ""), "aria-selected":u.view === v[0] ? "true" : "false",
          text:v[1], onclick:function(){ u.view = v[0]; u.tplSave = false; u.flash = ""; draw(); } });
      })),
      h("button", { type:"button", class:"pl-btn pl-ghost pl-keysbtn" + (u.keys ? " on" : ""), text:"keys", title:"shortcuts (?)",
        "aria-expanded":u.keys ? "true" : "false", onclick:function(){ u.keys = !u.keys; draw(); } }),
      h("button", { type:"button", class:"pl-btn pl-primary pl-addbtn", text:"+ add", onclick:function(){ openNew({ date:u.date }); } }) ]);
  }

  // ===== FORM (add / edit an activity) =====
  function blankDraft(date){
    return { title:"", area:"personal", sub:"", date:date || u.date, start:"", end:"", allDay:false, to:"", prio:0, due:"", notes:"",
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
      end:it.end == null ? "" : hm(it.end), allDay:!!it.allDay, to:it.to || "", prio:it.prio, due:it.due || "", notes:it.notes || "",
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
    // any minute works; picking a start fills an empty end one hour later
    var noTime = h("p", { class:"pl-hint wide", text:"no time: it goes on the task list." });
    var startIn = inp({ type:"time", class:"pl-fstart" }, "start"), endIn = inp({ type:"time", class:"pl-fend" }, "end");
    function paintNoTime(){ noTime.hidden = d.allDay || !(d.start === "" && d.end === ""); }
    startIn.addEventListener("input", function(){
      var sv = parseHm(d.start);
      if(sv != null && d.end === ""){ d.end = hm(Math.min(sv + 60, 1439)); endIn.value = d.end; }
      paintNoTime();
    });
    endIn.addEventListener("input", paintNoTime);
    var title = inp({ type:"text", class:"pl-ftitle", placeholder:"what is it? e.g. SQLi lab, push day, landing page", maxlength:"120" }, "title");
    var subs = SUBS[d.area];
    var grid = h("div", { class:"pl-fgrid" }, [
      h("label", { class:"wide" }, [ "title", title ]),
      h("label", null, [ "focus area", sel("area", AREAS.map(function(a){ return [a, areaName(a)]; }), true) ]),
      subs.length ? h("label", null, [ "type", sel("sub", [["", "—"]].concat(subs.map(function(s){
        return [s, s === "flex" ? "flex time (if work allows)" : s];
      }))) ]) : null,
      h("label", null, [ ruleMode ? "starts" : "date", inp({ type:"date" }, "date") ]),
      d.allDay ? null : h("label", null, [ "start", startIn ]),
      d.allDay ? null : h("label", null, [ "end", endIn ]),
      d.allDay && !seriesScope ? h("label", null, [ "until (optional)", inp({ type:"date" }, "to") ]) : null,
      h("label", { class:"pl-check" }, [ h("input", { type:"checkbox", checked:d.allDay ? true : null,
        onchange:function(e){ d.allDay = e.target.checked; draw(); } }), "all day" ]),
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
    if(d.area === "work" && d.sub === "flex") grid.appendChild(h("p", { class:"pl-hint wide", text:"flex time isn't counted as work. plan study or side hustle inside it." }));
    paintNoTime(); grid.appendChild(noTime);
    var scope = (rule && !ruleMode) ? h("div", { class:"pl-toggle" }, [["day", "this day only"], ["series", "the whole series"]].map(function(s){
      return h("button", { type:"button", class:"pl-tog" + (d.scope === s[0] ? " on" : ""), text:s[1], onclick:function(){ d.scope = s[0]; draw(); } });
    })) : null;
    var head = h("div", { class:"pl-fhead" }, [
      h("h3", { class:"pl-h", text:ruleMode ? "edit repeating activity" : F.copied ? "copy made: adjust it" : F.key ? "edit activity" : "new activity" }), scope ]);
    var buttons = [
      h("button", { type:"submit", class:"pl-btn pl-primary", text:"save" }),
      h("button", { type:"button", class:"pl-btn pl-ghost", text:"cancel", onclick:function(){ u.form = null; draw(); } })
    ];
    if(it) buttons.push(h("button", { type:"button", class:"pl-btn pl-ghost", text:"duplicate", title:"a one-off copy right after this one, opened for editing",
      onclick:function(){ duplicate(it); } }));
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
    if(!d.allDay){
      if((d.start === "") !== (d.end === "")) return "set both start and end, or leave both empty for a task without a time";
      if(d.start !== "" && (s == null || e == null)) return "times look wrong";
      if(d.start !== "" && e <= s) return "end must be after start";
    }else if(d.to && (!isDate(d.to) || d.to < d.date)) return "“until” must be on or after the date";
    if(d.due && !isDate(d.due)) return "deadline looks wrong";
    var f = normFields({}, { title:d.title, area:d.area, sub:d.sub, start:s, end:e, allDay:d.allDay, prio:d.prio, notes:d.notes, due:d.due });
    // a several-day all-day item keeps its last day
    var setTo = function(a){ if(d.allDay && isDate(d.to) && d.to > a.date) a.to = d.to; else delete a.to; };
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
        var a = { id:rid(), date:d.date, done:false, createdAt:Date.now() }; setFields(a, f); setTo(a);
        P.acts.push(a);
      }
    }else{
      var it = findItem(F.key), rule = it ? liveRule(it) : null;
      if(!it){ u.form = null; draw(); return ""; }
      if(rule && d.scope === "series"){
        setFields(rule, f); delete rule.due; rule.days = repeatDays(d);
        if(!it.virtual){ setFields(it, f); delete it.due; it.date = d.date; }
      }else if(rule){
        var m = materialize(it); setFields(m, f); m.date = d.date; setTo(m);
      }else{
        setFields(it, f); it.date = d.date; setTo(it);
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
  // a one-off copy (never part of a series, not done) placed right after the original when it fits
  // before midnight, then opened so its time or date can be changed; one save, so one Ctrl+Z
  function duplicate(it){
    var a = { id:rid(), date:it.date, done:false, createdAt:Date.now() };
    setFields(a, it);
    if(it.to) a.to = it.to;
    if(!it.allDay && it.start != null){ var len = it.end - it.start; if(it.end + len <= 1440){ a.start = it.end; a.end = it.end + len; } }
    P.acts.push(a);
    u.form = { key:a.id, d:draftOf(a, a.date), copied:true };
    commit(); focusTitle();
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
    if(notTask(it)) return null;
    return h("button", { type:"button", class:"pl-chk" + (it.done ? " on" : ""), "aria-pressed":it.done ? "true" : "false",
      "aria-label":(it.done ? "untick " : "tick ") + it.title, text:it.done ? "✓" : "",
      onclick:function(e){ e.stopPropagation(); toggle(it); }, onpointerdown:function(e){ e.stopPropagation(); } });
  }
  function meta(it){
    var bits = [];
    if(it.prio) bits.push(PRIO[it.prio]);
    if(it.due) bits.push("due " + short(it.due).toLowerCase());
    return bits.join("  ");
  }
  // the details live in the tooltip
  function tip(it){
    return (it.allDay ? "all day" + (it.to ? " until " + dayLabel(it.to).toLowerCase() : "") + "  " : it.start != null ? hm(it.start) + "–" + hm(it.end) + "  " : "") + it.title + "\n" +
      [areaName(it.area), it.sub, it.ruleId && liveRule(it) ? "repeats" : ""].filter(Boolean).join(", ");
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
      return !a.done && !notTask(a) && ((!a.ruleId && a.date < t) || (a.due && a.due < t));
    }).sort(function(a, b){ return a.date < b.date ? -1 : 1; });
  }
  function dayView(){
    var d = u.date, t = today(), items = itemsOn(d);
    var timed = items.filter(function(it){ return it.start != null; });
    var untimed = items.filter(function(it){ return it.start == null && !it.allDay; });
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
    // timeline or a plain checklist of the day
    var listMode = P.settings.dayMode === "list";
    left.appendChild(h("div", { class:"pl-dhead" }, [
      h("div", { class:"pl-toggle pl-modes" }, [["timeline", "timeline"], ["list", "list"]].map(function(m){
        return h("button", { type:"button", class:"pl-tog" + (P.settings.dayMode === m[0] ? " on" : ""), "aria-pressed":P.settings.dayMode === m[0] ? "true" : "false", text:m[1],
          onclick:function(){ if(P.settings.dayMode !== m[0]){ P.settings.dayMode = m[0]; commit(); } } });
      })),
      h("button", { type:"button", class:"pl-link pl-planlink" + (u.planDay ? " on" : ""), text:"plan day",
        onclick:function(){ u.planDay = !u.planDay; draw(); var x = root.querySelector(".pl-plan"); if(x) x.focus(); } }),
      h("button", { type:"button", class:"pl-link" + (P.rest[d] ? " on" : ""), text:P.rest[d] ? "rest day ✓" : "rest day",
        onclick:function(){ if(P.rest[d]) delete P.rest[d]; else P.rest[d] = true; commit(); } })
    ]));
    // time per area for the day: done / planned (flex windows and all-day items aren't time)
    var perArea = {};
    items.forEach(function(it){
      if(notTask(it) || it.start == null) return;
      var pa = perArea[it.area] || (perArea[it.area] = { plan:0, done:0 });
      pa.plan += mins(it); if(it.done) pa.done += mins(it);
    });
    var sumAreas = AREAS.filter(function(a){ return perArea[a] && perArea[a].plan > 0; });
    if(sumAreas.length) left.appendChild(h("div", { class:"pl-dsum", title:"done / planned today" }, sumAreas.map(function(a){
      var pa = perArea[a], all = pa.done >= pa.plan;
      return h("span", { class:"a-" + a + (all ? " on" : "") }, [ areaName(a) + " ",
        h("b", { text:all ? hm2(pa.plan) + " ✓" : hm2(pa.done) }), all ? null : " / " + hm2(pa.plan) ]);
    })));
    if(u.planDay) left.appendChild(planPanel(d));
    else if(!items.length) left.appendChild(h("div", { class:"pl-emptyday" }, [
      h("b", { text:"nothing planned" + (d === t ? " today" : "") }),
      h("div", { class:"pl-frow" }, [
        h("button", { type:"button", class:"pl-btn pl-primary", text:"plan the day", onclick:function(){ u.planDay = true; draw(); var x = root.querySelector(".pl-plan"); if(x) x.focus(); } }),
        h("button", { type:"button", class:"pl-btn", text:"+ add one thing", onclick:function(){ openNew({ date:d }); } }) ]) ]));
    // all-day items sit above everything else
    items.filter(function(it){ return it.allDay; }).forEach(function(it){
      left.appendChild(h("div", { class:"pl-allday a-" + it.area, title:tip(it), onclick:function(){ openEdit(it); } }, [
        h("span", { class:"pl-adlab", text:"all day" }), h("span", { class:"pl-adt", text:it.title }),
        it.to ? h("small", { text:(it.date < d ? "since " + short(it.date).toLowerCase() + ", " : "") + "until " + dayLabel(it.to).toLowerCase() }) : null ]));
    });
    // tasks without a time
    if(untimed.length) left.appendChild(h("div", { class:"pl-tasks" }, untimed.map(taskRow)));

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
        [ h("button", { type:"button", class:"pl-flab", text:"flex",
            onclick:function(e){ e.stopPropagation(); openEdit(it); } }) ]);
      grid.appendChild(band);
    });
    blocks.forEach(function(it){ grid.appendChild(block(it, lanes[keyOf(it)], s0, !!clash[keyOf(it)])); });
    if(d === t){
      var nm = nowMin();
      if(nm >= s0 && nm <= e0) grid.appendChild(h("div", { class:"pl-nowline", style:"top:" + Math.round((nm - s0) * PX) + "px" }));
    }
    if(listMode){
      var nm2 = nowMin();
      left.appendChild(h("div", { class:"pl-tasks pl-agenda" }, timed.length ? timed.map(function(it){
        var isNow = d === t && it.start <= nm2 && nm2 < it.end;
        return h("div", { class:"pl-task a-" + it.area + (it.done ? " done" : "") + (isFlex(it) ? " flex" : "") + (clash[keyOf(it)] ? " over" : "") + (isNow ? " now" : ""),
          title:tip(it), onclick:function(){ openEdit(it); } }, [
          chk(it) || h("span", { class:"pl-chk pl-nochk", "aria-hidden":"true" }),
          h("span", { class:"pl-atime", text:hm(it.start) + "–" + hm(it.end) }),
          h("span", { class:"pl-ttitle", text:isFlex(it) ? "flex" : it.title }),
          h("small", { text:meta(it) + (isNow ? "  now" : "") })
        ]);
      }) : items.length ? [ h("p", { class:"pl-hint", text:"nothing with a time yet" }) ] : []));
    }else{
      grid.title = "click empty time to add · drag a block to move it, its bottom edge to resize";
      left.appendChild(h("div", { class:"pl-gridwrap" }, [ grid ]));
    }

    // warnings sit right under the day's heading
    var warns = [];
    if(st.sched > P.settings.maxHours * 60) warns.push(hrs(st.sched) + " planned, over your " + P.settings.maxHours + "h limit");
    if(st.total > 14) warns.push(st.total + " things in one day");
    overlaps.forEach(function(it){ warns.push("overlap " + hm(it.start) + "–" + hm(it.end) + " " + it.title); });
    if(warns.length) left.insertBefore(h("div", { class:"pl-warns" }, warns.map(function(w){ return h("p", { text:w }); })), left.children[sumAreas.length ? 2 : 1]);

    // footer, like the tracker's: day tools on the left, reflection on the right
    var tools = [];
    var unfinished = items.filter(function(it){ return !it.virtual && !it.ruleId && !it.done && !notTask(it); });
    if(unfinished.length && d <= t){
      var nd = addDays(d, 1);
      tools.push(armed(h("button", { type:"button", class:"pl-btn", text:"carry " + unfinished.length + " to " + DOW[wd(nd)].toLowerCase() }),
        "sure?", function(){ unfinished.forEach(function(a){ a.date = nd; }); commit(); }));
    }
    tools.push(templateRow("day", d));
    left.appendChild(h("div", { class:"pl-foot" }, tools));
    if(d <= t){
      var rb = textBox("reflection", P.reflect, d, REFLECT, true);
      if(u.openRefl){ rb.open = true; u.openRefl = false; setTimeout(function(){ var ta = rb.querySelector("textarea"); if(ta){ ta.focus(); ta.scrollIntoView({ block:"center" }); } }, 0); }
      left.appendChild(rb);
    }

    var side = h("div", { class:"pl-dside" });
    if(d === t){
      var od = overdueList(t);
      if(od.length){
        side.appendChild(section("overdue", od.slice(0, 8).map(function(a){
          return h("div", { class:"pl-odrow" }, [ chk(a),
            h("button", { type:"button", class:"pl-odt", text:a.title, onclick:function(){ u.date = a.date; openEdit(a); } }),
            h("small", { text:a.due && a.due < t ? "due " + short(a.due).toLowerCase() : short(a.date).toLowerCase() }),
            h("button", { type:"button", class:"pl-act", title:"move to today", text:"→ today", onclick:function(){ a.date = t; commit(); } }) ]);
        }).concat(od.length > 8 ? [ h("p", { class:"pl-hint", text:"+" + (od.length - 8) + " more" }) ] : []),
        od.length > 1 ? armed(h("button", { type:"button", class:"pl-link", text:"all to today" }), "sure?", function(){
          od.forEach(function(a){ if(a.date < t) a.date = t; }); commit();
        }) : null));
      }
    }
    var dl = P.acts.filter(function(a){ return !a.done && a.due && a.due >= t && a.due <= addDays(t, 7); })
      .sort(function(a, b){ return a.due < b.due ? -1 : 1; });
    if(dl.length && d >= t) side.appendChild(section("due", dl.map(function(a){
      return h("button", { type:"button", class:"pl-dlrow", onclick:function(){ u.date = a.date; openEdit(a); } },
        [ h("span", { text:a.title }), h("small", { text:a.due === t ? "today" : dayLabel(a.due).toLowerCase() }) ]);
    })));
    var fs = freeSlots(d, blocks).slice(0, 3);
    if(fs.length){
      var rows = fs.map(function(x){
        var inFlex = 0;
        flex.forEach(function(f){ inFlex += Math.max(0, Math.min(f.end, x.end) - Math.max(f.start, x.start)); });
        return h("button", { type:"button", class:"pl-slot", title:"plan something here",
          onclick:function(){ openNew({ date:d, start:hm(x.start), end:hm(Math.min(x.end, x.start + 60)) }); } },
          [ h("span", { text:hm(x.start) + "–" + hm(x.end) }), h("small", { text:hrs(x.end - x.start) + (inFlex ? " flex" : "") }) ]);
      });
      side.appendChild(section("free", rows));
    }

    body.appendChild(h("div", { class:"pl-day" }, [ left, side ]));
  }
  // plan a whole day at once: one line per activity, read like the quick log
  // fill the day's free time toward what's left of this week's targets
  function suggest(d){
    var mon = wkStart(d), w = weekStats(mon), A = P.areas, lines = [];
    if(P.rest[d] || d < today()) return lines;
    var left = 0;
    for(var k = 0; k < 7; k++){ var dk = addDays(mon, k); if(dk >= d && !P.rest[dk]) left++; }
    left = Math.max(1, left);
    var items = itemsOn(d), blocks = items.filter(function(it){ return it.start != null && !notTask(it); });
    var budget = P.settings.maxHours * 60;
    blocks.forEach(function(b){ budget -= mins(b); });
    var slots = freeSlots(d, blocks);
    function take(len, evening){
      var order = slots.slice().sort(function(a, b){ return evening ? ((b.end > 1020) - (a.end > 1020)) || a.start - b.start : a.start - b.start; });
      for(var i = 0; i < order.length; i++){
        var sl = order[i], st = evening ? Math.max(sl.start, Math.min(sl.end - len, 1050)) : sl.start;
        if(sl.end - st < len) continue;
        var j = slots.indexOf(sl);
        slots.splice.apply(slots, [j, 1].concat([{ start:sl.start, end:st }, { start:st + len + 15, end:sl.end }].filter(function(x){ return x.end - x.start >= 30; })));
        return { start:st, end:st + len };
      }
      return null;
    }
    if(A.gym.target > 0 && A.gym.unit === "sessions" && scheduled(w, "gym") < A.gym.target && !items.some(function(it){ return it.area === "gym"; }) && budget >= 60){
      var g = take(60, true);
      if(g){ lines.push([g.start, hm(g.start) + "-" + hm(g.end) + " gym"]); budget -= 60; }
    }
    // does the side hustle have anything money-facing this week yet?
    var money = false;
    for(var m = 0; m < 7; m++) itemsOn(addDays(mon, m)).forEach(function(it){ if(it.area === "side" && MONEY_SUBS.indexOf(it.sub) >= 0) money = true; });
    ["cwes", "side"].forEach(function(a){
      if(!(A[a].target > 0) || A[a].unit !== "h") return;
      var onDay = 0;
      blocks.forEach(function(b){ if(b.area === a) onDay += mins(b); });
      var need = A[a].target * 60 - (w.area[a].sched - onDay);
      if(need <= 0) return;
      var share = Math.min(180, Math.ceil(need / left / 30) * 30) - onDay;
      while(share >= 30 && budget >= 30){
        var len = Math.min(90, share, budget), r = take(len, false);
        if(!r) break;
        var sub = a === "cwes" ? ["theory", "lab", "revision"][hash(d + r.start) % 3] : (money ? "build" : "marketing");
        if(a === "side") money = true;
        lines.push([r.start, hm(r.start) + "-" + hm(r.end) + " " + a + " " + sub]);
        share -= len; budget -= len;
      }
    });
    return lines.sort(function(x, y){ return x[0] - y[0]; }).map(function(x){ return x[1]; });
  }
  function planPanel(d){
    var ta = h("textarea", { class:"pl-in pl-plan", rows:"7", maxlength:"4000", value:u.planText || "",
      placeholder:"one per line\n9-11 core work\n11:15-12:15 cwes lab sqli\n12:30-1:30 lunch\ngym 1h\n6-7pm side landing page\nexam prep all day",
      oninput:function(){ u.planText = ta.value; paint(); },
      onkeydown:function(e){
        if(e.key === "Enter" && (e.ctrlKey || e.metaKey)){ e.preventDefault(); addAll(); }
        if(e.key === "Escape"){ e.preventDefault(); u.planDay = false; draw(); }
      } });
    var list = h("div", { class:"pl-planprev" });
    var addBtn = h("button", { type:"button", class:"pl-btn pl-primary", onclick:function(){ addAll(); } });
    function parsedLines(){
      var cursor = P.settings.dayStart;
      return (ta.value || "").split("\n").map(function(l){ return l.trim(); }).filter(Boolean).map(function(l){
        var q = parseQuick(l, P, d, nowMin(), true);
        if(!q) return null;
        // a bare length goes right after the line before it
        if(!q.allDay && q.start == null && q.dur){ q.start = cursor; q.end = Math.min(1440, cursor + q.dur); }
        if(q.end != null) cursor = Math.max(cursor, q.end);
        return q;
      }).filter(Boolean);
    }
    function paint(){
      var qs = parsedLines();
      list.innerHTML = "";
      // clashes with what's already planned that day and with each other (work inside work is fine)
      var timed = itemsOn(d).filter(function(it){ return it.start != null && !notTask(it); }).concat(qs.filter(function(q){ return q.start != null && q.date === d && !(q.area === "work" && q.sub === "flex"); }));
      qs.forEach(function(q){
        var clash = q.start != null && timed.some(function(o){ return o !== q && o.start < q.end && q.start < o.end && !(o.area === "work" && q.area === "work"); });
        list.appendChild(h("div", { class:"pl-pprow a-" + q.area + (clash ? " over" : "") }, [
          h("span", { class:"pl-atime", text:q.allDay ? "all day" : q.start != null ? hm(q.start) + "–" + hm(q.end) : "task" }),
          h("span", { class:"pl-ttitle", text:q.title }),
          h("small", { text:(q.date !== d ? dayLabel(q.date).toLowerCase() + "  " : "") + (clash ? "clash  " : "") + (q.area === "personal" ? "" : P.areas[q.area].name) })
        ]));
      });
      addBtn.textContent = qs.length ? "add " + qs.length : "add";
      addBtn.disabled = !qs.length;
    }
    function addAll(){
      var qs = parsedLines();
      if(!qs.length) return;
      qs.forEach(function(q){
        var a = { id:rid(), date:q.date, done:!!q.done, createdAt:Date.now() };
        setFields(a, normFields({}, q));
        P.acts.push(a);
      });
      u.planDay = false; u.planText = "";
      commit();
    }
    paint();
    return h("div", { class:"pl-planbox" }, [ ta, list, h("div", { class:"pl-frow" }, [ addBtn,
      h("button", { type:"button", class:"pl-btn pl-ghost", text:"cancel", onclick:function(){ u.planDay = false; draw(); } }),
      h("button", { type:"button", class:"pl-btn", text:"suggest", title:"fill free time toward this week's targets", onclick:function(){
        var ls = suggest(d);
        if(!ls.length){ toast("nothing to suggest", "targets covered, or no free time left"); return; }
        ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + ls.join("\n");
        u.planText = ta.value; paint(); ta.focus();
      } }),
      h("span", { class:"pl-hint", text:"ctrl+enter adds" }) ]) ]);
  }
  function taskRow(it){
    return h("div", { class:"pl-task a-" + it.area + (it.done ? " done" : ""), title:tip(it), onclick:function(){ openEdit(it); } }, [
      chk(it), h("span", { class:"pl-ttitle", text:it.title }),
      h("small", { text:meta(it) })
    ]);
  }
  var justDragged = false;
  function block(it, ln, s0, isClash){
    var top = Math.round((it.start - s0) * PX), ht = Math.max(12, Math.round(mins(it) * PX) - 2);
    var el = h("div", { class:"pl-blk a-" + it.area + (it.done ? " done" : "") + (isClash ? " over" : "") + (ht < 30 ? " tiny" : ""),
      style:"top:" + top + "px;height:" + ht + "px;--l:" + ln.lane + ";--n:" + ln.lanes,
      tabindex:"0", role:"button", title:tip(it), "aria-label":hm(it.start) + " to " + hm(it.end) + " " + it.title + (it.done ? ", done" : ""),
      onclick:function(){ if(justDragged) return; openEdit(it); },
      onkeydown:function(e){ if(e.key === "Enter"){ e.preventDefault(); openEdit(it); } } }, [
      chk(it),
      h("span", { class:"pl-btime", text:hm(it.start) + "–" + hm(it.end) }),
      h("span", { class:"pl-btitle", text:it.title }),
      h("span", { class:"pl-bmeta", text:meta(it) + (isClash ? "  overlap" : "") }),
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
  function blocksOf(list){ return list.filter(function(it){ return !it.to; }).map(function(it){ var f = {}; setFields(f, it); delete f.due; return f; }); }
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
    var mon = wkStart(date);
    var kids = [];
    if(u.tplSave){
      var name = h("input", { type:"text", class:"pl-in", placeholder:"template name, e.g. office day", maxlength:"40",
        onkeydown:function(e){ if(e.key === "Enter"){ e.preventDefault(); saveTpl(); } if(e.key === "Escape"){ u.tplSave = false; draw(); } } });
      var saveTpl = function(){
        if(!name.value.trim()){ name.focus(); return; }
        var days = [blocksOf(itemsOn(date))];
        if(kind === "week"){
          days = [[], [], [], [], [], [], []];
          for(var k = 0; k < 7; k++){ var dk = addDays(mon, k); days[wd(dk)] = blocksOf(itemsOn(dk)); }
        }
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
          else for(var k = 0; k < 7; k++){ var dk = addDays(mon, k); n += applyBlocks(dk, tp.days[wd(dk)]); }
          u.flash = "added " + n + " from “" + tp.name + "”"; commit();
        } }, [ h("option", { value:"", text:kind + " template…" }) ].concat(list.map(function(t){ return h("option", { value:t.id, text:t.name }); })));
        row.push(s);
      }
      var hasAny = kind === "day" ? itemsOn(date).length > 0 : [0, 1, 2, 3, 4, 5, 6].some(function(k){ return itemsOn(addDays(mon, k)).length > 0; });
      if(hasAny) row.push(h("button", { type:"button", class:"pl-btn pl-ghost", text:"save as template", onclick:function(){ u.tplSave = true; u.flash = ""; draw(); } }));
      kids = kids.concat(row);
    }
    if(u.flash) kids.push(h("span", { class:"pl-hint", text:u.flash }));
    return h("span", { class:"pl-tpl" }, kids);
  }
  // reflection / review: optional questions saved as you type
  var reflT = null;
  function textBox(title, store, key, qs, live){
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
          // scoring the whole game on every keystroke gets slow with history: wait for a pause
          if(live){
            clearTimeout(reflT);
            reflT = setTimeout(function(){ if(!root.isConnected) return; if(gameStep()) repaintDash(); ctx.save(); }, 700);
          }
        } }) ]));
    });
    return det;
  }

  // ===== WEEK VIEW =====
  var dragKey = null;
  function weekView(){
    var mon = wkStart(u.date), t = today(), w = weekStats(mon);
    var cols = [];
    for(var k = 0; k < 7; k++) cols.push(dayCol(addDays(mon, k), w.days[k], t));
    if(!GM.off){ var B = mon === wkStart(t) ? curG.boss : bossOf(mon, w); var bc = bossCard(B); if(bc) body.appendChild(bc);
      if(mon === wkStart(t) && curG.weekQ.length) body.appendChild(h("div", { class:"pl-wquests" }, curG.weekQ.map(questLine))); }
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
      u.flash = "copied " + n; commit();
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
        var a = materialize(it);
        if(a.to){ a.to = addDays(a.to, Math.round((pd(d) - pd(a.date)) / 864e5)); }
        a.date = d; commit();
      } }, [
      h("button", { type:"button", class:"pl-colhead", title:"open this day", onclick:function(){ u.view = "day"; u.date = d; draw(); } }, [
        h("b", { text:DOW[wd(d)] + " " + +d.slice(8, 10) }),
        h("small", null, [ st.total ? st.done + "/" + st.total : (P.rest[d] ? "rest" : ""),
          counts(d) ? h("b", { class:"pl-streak", title:"counts for the streak", text:" ✓" }) : null ])
      ]),
      st.total ? pbar(st.done / st.total) : null
    ]);
    if(P.rest[d]) col.appendChild(h("div", { class:"pl-restlab", text:"rest day" }));
    items.filter(function(it){ return !isFlex(it); }).forEach(function(it){
      var row = h("div", { class:"pl-wi a-" + it.area + (it.done ? " done" : "") + (it.allDay ? " allday" : ""), draggable:"true", title:tip(it),
        onclick:function(){ openEdit(it); },
        ondragstart:function(e){ dragKey = keyOf(it); e.dataTransfer.effectAllowed = "move"; try{ e.dataTransfer.setData("text/plain", it.title); }catch(err){} },
        ondragend:function(){ dragKey = null; } }, [
        chk(it),
        h("span", { class:"pl-wtime", text:it.allDay ? "all day" : it.start != null ? hm(it.start) : "" }),
        h("span", { class:"pl-wtitle", text:it.title })
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
        h("td", { class:"num" + (pct != null && pct < 50 && mon < wkStart(today()) ? " pl-red" : ""), text:pct == null ? "—" : pct + "%" })
      ]);
    });
    return section("weekly scorecard", [
      h("div", { class:"pl-twrap" }, [ h("table", { class:"pl-table" }, [
        h("thead", null, [ h("tr", null, ["metric", "target", "scheduled", "actual", "vs target"].map(function(c, i){ return h("th", { class:i ? "num" : "", text:c }); })) ]),
        h("tbody", null, rows)
      ]) ]),
    ]);
  }

  // ===== FOCUS AREAS =====
  function focusView(){
    var mon = wkStart(u.date), w = weekStats(mon), t = today();
    var subLabels = { work:"by type", gym:"by type", cwes:"study by type", side:"time by type" };
    body.appendChild(h("div", { class:"pl-focus" }, FOCUS.map(function(a){
      var A = P.areas[a], W = w.area[a], act = actual(w, a);
      var list = [];
      for(var k = 0; k < 7; k++) itemsOn(addDays(mon, k)).forEach(function(it){ if(it.area === a && !notTask(it) && it.date === addDays(mon, k)) list.push(it); });
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
        kids.push(h("p", { class:"pl-fline" + (money ? "" : " pl-red"), text:"marketing + monetize: " + hrs(money) + " of " + hrs(W.done) }));
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
      [ h("option", { value:"all", text:"all of it is done" }), h("option", { value:"pct", text:"a % of it is done" }) ]);
    rsel.value = P.streak.rule;
    var L = linked();
    body.appendChild(section("streak", [ h("div", { class:"pl-srow" }, [
      h("label", null, [ "linked streak page", tsel ]),
      h("label", null, [ "a day counts when", rsel ]),
      P.streak.rule === "pct" ? h("label", null, [ "share done (%)", h("input", { class:"pl-in pl-num", type:"number", min:"10", max:"100", step:"5", value:String(P.streak.pct),
        onchange:function(e){ var v = Math.round(+e.target.value); if(v >= 10 && v <= 100) P.streak.pct = v; commit(); } }) ]) : null
    ]), h("p", { class:"pl-hint", text:L ? "a day that counts ticks its box on “" + L.title + "” (streak " + L.cur + ", best " + L.best + "). flex time doesn't count, and unticking here never unticks a box." :
      "pick one of your day trackers: each day you finish what you planned ticks that day's box, so the streak keeps itself. a tracker without a start date starts today." }) ]));

    // main priority: what the quests lean toward
    var fsel = h("select", { class:"pl-in", "aria-label":"main priority", onchange:function(e){ P.settings.focus = e.target.value; commit(); } },
      [["cwes", "CWES study"], ["side", "side hustle"], ["gym", "gym"], ["balanced", "balanced"]].map(function(x){ return h("option", { value:x[0], text:x[1] }); }));
    fsel.value = P.settings.focus || "cwes";
    var ssel = h("select", { class:"pl-in", "aria-label":"quest style", onchange:function(e){ P.settings.questStyle = e.target.value; commit(); } },
      [["flexible", "flexible"], ["structured", "structured"]].map(function(x){ return h("option", { value:x[0], text:x[1] }); }));
    ssel.value = P.settings.questStyle || "flexible";
    body.appendChild(section("main priority", [ h("div", { class:"pl-srow" }, [ h("label", null, [ "quests lean toward", fsel ]), h("label", null, [ "quest style", ssel ]) ]),
      h("p", { class:"pl-hint", text:"most daily and weekly quests come from this area; the others still show up now and then. flexible quests only ask for time and consistency, never how to study; structured adds labs, theory, revision, long blocks and topics. a change applies to today's and this week's quests if none of them is done yet, otherwise from the next day or week." }) ]));
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
      (function(){
        var ws = h("select", { class:"pl-in", "aria-label":"week starts on", onchange:function(e){ P.settings.weekStart = +e.target.value; commit(); } },
          DAYNAME.map(function(n, i){ return h("option", { value:String(i), text:n.toLowerCase() }); }));
        ws.value = String(P.settings.weekStart);
        return h("label", null, [ "week starts on", ws ]);
      })(),
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

  if(ctx.headless) return { parts:function(o){ buildIndex(); return planParts(o); }, finish:finish,
    // for tests: the quest generator
    quests:{ pickDaily:function(d){ buildIndex(); return pickDaily(d, dayCtx(d)); }, pickWeekly:function(m){ buildIndex(); return pickWeekly(m, weekCtx(m)); },
      resolve:resolveQ, DT:DT, WT:WT } };
  if(ctx.gameOnly){ activePl = null; draw(); return; }
  activePl = { root:root, key:function(e){
    for(var i = 0; i < KEYS.length; i++) if(KEYS[i][0] === e.key){ e.preventDefault(); KEYS[i][2](); return; }
  } };
  draw();
}

// ---------- styles ----------
var css = `
.pl{margin-top:.5rem;}
.pl .a-work{--ac:#8a8a8a;} .pl .a-gym{--ac:#e5484b;} .pl .a-cwes{--ac:#4f8fe8;} .pl .a-side{--ac:#cc6f16;} .pl .a-personal{--ac:#4a4a4a;}
/* header: the tracker's count, bar and boxes */
.pl-dash{margin-bottom:1.6rem;}
.pl-stats{margin-bottom:1rem;}
.pl-cnt{font-size:.75rem; color:var(--muted); letter-spacing:.08em; margin-left:.6rem;}
.pl-dbar{margin-bottom:1rem;}
.pl-wk{display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); gap:.4rem; margin-bottom:1rem;}
.pl-wkc{aspect-ratio:auto; height:3.2rem; flex-direction:column; gap:.15rem; font-size:.66rem; overflow:hidden;}
.pl-wkp{position:absolute; left:0; bottom:0; height:3px; background:var(--accent);}
.pl-wkc b{font-size:.66rem; letter-spacing:.1em;}
.pl-wkc.done span{color:var(--accent-ink);}
.pl-next{display:flex; flex-wrap:wrap; align-items:center; gap:.4rem 1.2rem; font-size:.75rem;}
.pl-nlab{font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted);}
.pl-qprev:empty{display:none;}
.pl-warns{margin:-.2rem 0 .8rem;}
.pl-warns p{margin:0 0 .2rem; font-size:.72rem; color:var(--accent);}
.pl-foot{display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; border-top:2px solid var(--line); padding-top:1rem; margin-top:1.4rem;}
.pl-tpl{display:inline-flex; align-items:center; gap:.4rem; flex-wrap:wrap;}
.pl-tpl select.pl-in{width:auto; font-size:.72rem; padding:.42rem .4rem;}
.pl-tpl .pl-hint{margin:0;}
.pl-foot + .pl-refl{margin-top:1rem;}
.pl-sec{margin-bottom:1.4rem; min-width:0;}
.pl-shead{display:flex; justify-content:space-between; align-items:baseline; gap:1rem; margin-bottom:.55rem;}
.pl-h{display:flex; align-items:center; gap:.4rem; margin:0; font-size:.64rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted);}
.pl-hint{margin:.4rem 0 0; font-size:.66rem; color:var(--muted); letter-spacing:.03em; line-height:1.55;}
.pl-red{color:var(--accent) !important;}
.pl-sw{display:none; width:9px; height:9px; flex:0 0 9px; background:var(--ac);}
.pl-arow .pl-sw, .pl-rrow .pl-sw{display:inline-block;}
.pl-lmuted{color:var(--muted);}
.pl-pbar{display:block; height:10px; border:2px solid var(--line); position:relative;}
.pl-pbar i{position:absolute; left:0; top:0; bottom:0; background:var(--accent);}
.pl-next{display:flex; flex-wrap:wrap; align-items:center; gap:.4rem .9rem; margin-top:.6rem; font-size:.7rem;}
.pl-nextit{display:inline-flex; align-items:center; gap:.4rem; background:transparent; border:none; color:var(--fg); font:inherit; padding:0; cursor:pointer;}
.pl-nextit:hover{color:var(--accent);}
/* toolbar */
.pl-bar{display:flex; align-items:flex-end; gap:.4rem 1.2rem; flex-wrap:wrap; border-bottom:2px solid var(--fg); margin-bottom:1.2rem;}
.pl-bar .pl-navrow{padding-bottom:.45rem;}
.pl-bar .pl-addbtn{margin-bottom:.45rem;}
.pl-bar .pl-keysbtn{margin-left:auto; margin-bottom:.45rem;}
.pl-keysbtn.on{border-color:var(--fg); color:var(--fg);}
.pl-keys{display:grid; grid-template-columns:repeat(auto-fill, minmax(10.5rem, 1fr)); gap:.35rem; border:2px solid var(--fg); padding:.6rem; margin:-.6rem 0 1.2rem;}
.pl-key{display:flex; align-items:center; gap:.6rem; background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.72rem; padding:.4rem .5rem; cursor:pointer; text-align:left;}
.pl-key:hover{border-color:var(--accent);}
.pl-key kbd{display:inline-block; min-width:1.5rem; text-align:center; font-family:var(--mono); font-size:.72rem; font-weight:700;
  border:2px solid var(--fg); padding:.05rem .3rem; color:var(--fg); background:var(--bg);}
.pl-navrow{display:flex; align-items:center; gap:.6rem;}
.pl-navlabel{font-size:1rem; font-weight:700; letter-spacing:.1em; text-transform:uppercase; min-width:8.5rem; text-align:center;}
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
.pl-tabs{display:flex; overflow-x:auto; scrollbar-width:none;}
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
.pl-tog.on{border-color:var(--fg); background:var(--fg); color:var(--accent-ink);}
.pl-days{display:flex; gap:0;}
.pl-dtog{flex:1 1 0; background:transparent; border:2px solid var(--line); color:var(--muted); font:inherit; font-size:.62rem; letter-spacing:.08em; padding:.35rem 0; cursor:pointer;}
.pl-dtog + .pl-dtog{border-left:none;}
.pl-dtog.on{background:var(--fg); color:var(--accent-ink); border-color:var(--fg);}
.pl-msg{min-height:1.1em; margin:.55rem 0 .2rem; font-size:.7rem; color:var(--accent);}
.pl-frow{display:flex; gap:.4rem; flex-wrap:wrap;}
.pl-del{margin-left:auto;}
/* day view */
.pl-day{display:grid; grid-template-columns:minmax(0, 1fr) 17rem; gap:1.4rem; align-items:start;}
.pl-dsum{display:flex; flex-wrap:wrap; gap:.3rem 1.4rem; margin:-.15rem 0 .75rem; font-size:.72rem; color:var(--muted);}
.pl-dsum span{border-left:2px solid var(--ac); padding-left:.5rem;}
.pl-dsum b{color:var(--fg); font-weight:700;}
.pl-dsum .on b{color:var(--accent);}
.pl-dhead{display:flex; align-items:baseline; gap:.4rem 1rem; flex-wrap:wrap; margin-bottom:.6rem;}
.pl-dtitle{margin:0; font-size:.95rem; letter-spacing:.08em; text-transform:uppercase;}
.pl-dtitle.now::after{content:" · today"; color:var(--accent);}
.pl-dstat{font-size:.64rem; color:var(--muted); letter-spacing:.05em;}
.pl-dhead .pl-link{margin-left:auto;}
.pl-tasks{display:flex; flex-direction:column; gap:.3rem; margin-bottom:.8rem;}
.pl-task{display:flex; align-items:center; gap:.5rem; border:2px solid var(--line); border-left:3px solid var(--ac); padding:.3rem .5rem; font-size:.74rem; cursor:pointer; min-width:0;}
.pl-task:hover{border-color:var(--fg); border-left-color:var(--ac);}
.pl-task small{margin-left:auto; color:var(--muted); font-size:.6rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; flex:0 1 auto;}
.pl-ttitle{overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 1 auto; min-width:0;}
.pl-task.done .pl-ttitle, .pl-blk.done .pl-btitle, .pl-wi.done .pl-wtitle{text-decoration:line-through; color:var(--muted);}
.pl-qrow{display:flex; gap:.3rem; align-items:stretch; flex-wrap:wrap;}
.pl-qrow > .pl-in{flex:1 1 9rem; width:auto;}
.pl-qrow .pl-qarea{flex:0 0 8.5rem;}
.pl-chk{flex:0 0 auto; width:16px; height:16px; padding:0; border:2px solid var(--fg); background:transparent; color:var(--accent-ink); font:inherit; font-size:.62rem; line-height:12px; cursor:pointer; text-align:center;}
.pl-chk.on{background:var(--accent); border-color:var(--accent);}
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
  background:#141414; border:2px solid var(--line); border-left:3px solid var(--ac); padding:.2rem .4rem .2rem 1.6rem; font-size:.66rem; line-height:1.3;}
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
.pl-col.now{box-shadow:inset 0 0 0 2px var(--fg); border-color:var(--fg);}
.pl-col.past{opacity:.75;}
.pl-col.rest{background:repeating-linear-gradient(135deg, transparent 0 8px, #151515 8px 10px);}
.pl-col.dropping{border-color:var(--fg); border-style:dashed;}
.pl-colhead{display:flex; justify-content:space-between; align-items:baseline; gap:.3rem; background:transparent; border:none; color:var(--fg); font:inherit; padding:0 0 .2rem; cursor:pointer; text-align:left;}
.pl-colhead b{font-size:.7rem; letter-spacing:.08em;}

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
.pl-wactions{display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; border-top:2px solid var(--line); padding-top:1rem; margin-bottom:1.8rem;}
.pl-twrap{overflow-x:auto;}
.pl-table{width:100%; border-collapse:collapse; font-size:.74rem;}
.pl-table th{text-align:left; border-bottom:2px solid var(--fg); padding:.4rem .5rem; font-size:.58rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); font-weight:400;}
.pl-table td{border-bottom:2px solid var(--line); padding:.45rem .5rem; white-space:nowrap;}

.pl-table .num{text-align:right; font-variant-numeric:tabular-nums;}
/* focus areas */
.pl-focus{display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:.8rem;}
.pl-fcard{border:2px solid var(--line); border-left:3px solid var(--ac); padding:.75rem .8rem; display:flex; flex-direction:column; gap:.45rem; min-width:0;}
.pl-fcard .pl-shead{margin-bottom:0;}
.pl-fprog b{font-size:1.15rem; font-variant-numeric:tabular-nums;}
.pl-fprog small{color:var(--muted); font-size:.62rem;}
.pl-fline{margin:0; font-size:.66rem; color:var(--muted); line-height:1.5;}
.pl-flist{display:flex; flex-direction:column; gap:.25rem; max-height:16rem; overflow-y:auto;}
/* settings */
.pl-arows{display:flex; flex-direction:column; gap:.35rem; max-width:34rem;}
.pl-arow{display:grid; grid-template-columns:auto minmax(0, 1fr) 5.5rem 9.5rem; gap:.4rem; align-items:center;}
.pl-num{text-align:right;}
.pl-srow{display:grid; grid-template-columns:repeat(auto-fill, minmax(11.5rem, 1fr)); gap:.6rem; max-width:52rem;}
.pl-rrow{display:flex; align-items:center; gap:.5rem; border-bottom:2px solid var(--line); padding:.3rem 0; font-size:.72rem; max-width:40rem;}
.pl-rrow > .pl-in{flex:1 1 auto; width:auto; padding:.3rem .45rem;}
.pl-rtitle{flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.pl-rrow small{flex:1 1 auto; color:var(--muted); font-size:.6rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.pl-sec > .pl-btn{margin-top:.6rem;}
.pl-streak{color:var(--accent); font-weight:700;}
/* quick log + timer */
.pl-quick{margin-bottom:1rem;}
.pl-quick .pl-qrow > .pl-in{flex:1 1 14rem;}
.pl-qin{font-size:.85rem; padding:.6rem .7rem; border-color:var(--fg);}
.pl-qprev{min-height:1.2em; margin-top:.4rem; font-size:.66rem; color:var(--muted); line-height:1.5;}
.pl-qprev b{color:var(--fg);}
.pl-timer{display:flex; align-items:center; gap:.4rem .8rem; flex-wrap:wrap; border:2px solid var(--accent); padding:.5rem .7rem; margin-bottom:.5rem;}
.pl-tdot{display:inline-block; width:10px; height:10px; background:var(--accent);}
.pl-tclock{font-size:1.25rem; font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:.04em;}
.pl-tttl{flex:1 1 10rem; min-width:0; font-size:.74rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.pl-nextwrap{display:inline-flex; align-items:center; gap:.4rem;}
.pl-modes{margin:0;}
.pl-bmeta:empty, .pl-task small:empty{display:none;}
.pl-atime{flex:0 0 auto; min-width:5.7rem; font-size:.62rem; color:var(--muted); font-variant-numeric:tabular-nums;}
.pl-task.now{border-color:var(--accent); border-left-color:var(--ac);}
.pl-task.over{border-style:dashed; border-color:var(--accent); border-left:4px solid var(--ac);}
.pl-task.flex{background:repeating-linear-gradient(45deg, transparent 0 6px, #1b1b1b 6px 8px); color:var(--muted);}
.pl-nochk{border-color:transparent;}
.pl-allday{display:flex; align-items:baseline; gap:.7rem; border:2px solid var(--fg); border-left:3px solid var(--ac); padding:.45rem .6rem; margin-bottom:.4rem; cursor:pointer; font-size:.78rem; min-width:0;}
.pl-allday:hover{border-color:var(--accent); border-left-color:var(--ac);}
.pl-adlab{flex:0 0 auto; font-size:.6rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted);}
.pl-adt{flex:1 1 auto; font-weight:700; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.pl-allday small{color:var(--muted); font-size:.62rem; white-space:nowrap;}
.pl-wi.allday{background:transparent; border:1px solid var(--fg); border-left:3px solid var(--ac);}
.pl-wi.allday .pl-wtime{text-transform:uppercase; letter-spacing:.06em; font-size:.5rem;}
.pl-dhead .pl-planlink{margin-left:auto;}
.pl-dhead .pl-planlink + .pl-link{margin-left:0;}
.pl-planbox{border:2px solid var(--fg); padding:.7rem; margin-bottom:1rem; display:flex; flex-direction:column; gap:.6rem;}
.pl-plan{font-size:.8rem; line-height:1.6; min-height:9rem;}
.pl-planprev{display:flex; flex-direction:column; gap:.25rem;}
.pl-planprev:empty{display:none;}
.pl-pprow{display:flex; align-items:center; gap:.5rem; border-left:3px solid var(--ac); padding:.2rem .5rem; font-size:.72rem; background:#141414;}
.pl-pprow small{margin-left:auto; color:var(--muted); font-size:.6rem; white-space:nowrap;}
.pl-pprow.over{outline:2px dashed var(--accent); outline-offset:-2px;}
.pl-pprow.over small{color:var(--accent);}
.pl-frow .pl-hint{align-self:center; margin:0 0 0 .4rem;}
.pl-check{display:inline-flex; flex-direction:row !important; align-items:center; gap:.55rem !important; align-self:end; padding-bottom:.55rem; cursor:pointer;}
/* square checkboxes in the house style, not the browser's */
.pl input[type=checkbox]{-webkit-appearance:none; appearance:none; flex:0 0 auto; width:15px; height:15px; margin:0; border:2px solid var(--fg);
  background:transparent; border-radius:0; position:relative; cursor:pointer;}
.pl input[type=checkbox]:checked{background:var(--accent); border-color:var(--accent);}
.pl input[type=checkbox]:checked::after{content:"✓"; position:absolute; left:0; right:0; top:-1px; text-align:center; font-size:10px; line-height:12px; color:var(--accent-ink);}
.pl-btn:disabled{opacity:.4; cursor:default;}
/* game */
.pl-xprow{display:flex; align-items:center; gap:.7rem; margin:-.4rem 0 1rem; font-size:.66rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted);}
.pl-xprow b{color:var(--fg);}
.pl-xpbar{flex:1 1 auto; height:4px; background:var(--line); position:relative;}
.pl-xpbar i{position:absolute; left:0; top:0; bottom:0; background:var(--fg);}
.pl-xprow small{font-size:.6rem; white-space:nowrap;}
.pl-quests{margin-top:.8rem;}
.pl-quest{display:inline-flex; align-items:center; gap:.4rem; color:var(--muted);}
.pl-quest i{display:inline-block; width:12px; height:12px; border:2px solid var(--line); font-style:normal; font-size:.5rem; line-height:8px; text-align:center; color:var(--accent-ink);}
.pl-quest.on{color:var(--fg);}
.pl-quest.on i{background:var(--accent); border-color:var(--accent);}
.pl-qline{display:flex; padding:.35rem 0; border-bottom:2px solid var(--line); font-size:.76rem;}
.pl-qline small{margin-left:auto; font-size:.62rem; color:var(--muted);}
.pl-boss{display:flex; align-items:center; gap:.4rem .9rem; flex-wrap:wrap; border:2px solid var(--line); padding:.55rem .7rem; margin-bottom:1rem; font-size:.76rem;}
.pl-bname{text-transform:uppercase; letter-spacing:.08em;}
.pl-hp{flex:1 1 8rem; height:10px; border:2px solid var(--fg); position:relative;}
.pl-hp i{position:absolute; left:0; top:0; bottom:0; background:var(--accent);}
.pl-boss small{color:var(--muted); font-size:.64rem;}
.pl-boss.dead{border-color:var(--accent);}
.pl-boss.dead .pl-bname{text-decoration:line-through; color:var(--muted);}
.pl-boss.dead small{color:var(--accent);}
.pl-lvl{margin-bottom:1.6rem;}
.pl-lvl .bar{margin-bottom:.5rem;}
.pl-badges{display:grid; grid-template-columns:repeat(auto-fill, minmax(8.5rem, 1fr)); gap:.4rem;}
.pl-badge{aspect-ratio:auto; min-height:3.6rem; flex-direction:column; gap:.2rem; padding:.4rem; text-align:center; cursor:default;}
.pl-badge b{font-size:.64rem; letter-spacing:.06em; text-transform:uppercase;}
.pl-badge small{font-size:.58rem; color:var(--muted);}

.pl-xpline{display:flex; align-items:baseline; gap:.7rem; padding:.3rem 0; border-bottom:2px solid var(--line); font-size:.72rem;}
.pl-xpline small{flex:0 0 3.6rem; color:var(--muted); font-size:.6rem;}
.pl-xpline span{flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.pl-xpline b{color:var(--accent); font-size:.68rem; white-space:nowrap;}
.pl-gamesw{font-size:.74rem; text-transform:none; letter-spacing:0; color:var(--fg); padding:0;}
.pl-toast{position:fixed; left:1.2rem; bottom:1.2rem; z-index:600; background:var(--bg); border:2px solid var(--accent); padding:.55rem .8rem;
  font-family:var(--mono); display:flex; flex-direction:column; gap:.15rem; max-width:20rem; box-shadow:4px 4px 0 var(--line);}
.pl-toast b{font-size:.8rem; letter-spacing:.08em; text-transform:uppercase; color:var(--accent);}
.pl-toast small{font-size:.66rem; color:var(--muted);}
.pl-toast.pop{animation:pl-pop .18s steps(2) 1;}
@keyframes pl-pop{ from{ transform:translateY(6px); } to{ transform:none; } }
@media (prefers-reduced-motion:reduce){ .pl-toast.pop{animation:none;} }
.pl-coins{color:var(--fg) !important;}
.pl-qgo{flex:0 0 auto; min-width:5.6rem; background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.58rem;
  letter-spacing:.1em; text-transform:uppercase; padding:.25rem .45rem; cursor:pointer; text-align:center;}
.pl-qgo:hover{border-color:var(--accent); color:var(--accent);}
.pl-qdone{border-color:transparent; color:var(--accent); cursor:default;}
.pl-qhow{margin:-.2rem 0 .5rem;}
button.pl-quest{background:transparent; border:none; padding:0; font:inherit; color:var(--muted); cursor:pointer; text-align:left;}
button.pl-quest:hover{color:var(--accent);}
.pl-qline.go{cursor:pointer;}
.pl-qline.go:hover .pl-qlabel{color:var(--accent);}
.pl-quest.missed{opacity:.45;}
.pl-quest.missed i{border-style:dashed;}
.pl-qmiss{color:var(--muted);}
.pl-qprog{margin-left:.35rem; font-size:.58rem; color:var(--muted); font-variant-numeric:tabular-nums;}
.pl-qweek{margin-left:auto; font-size:.6rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); cursor:help;}
.pl-qline .pl-qlabel{flex:1 1 auto; min-width:0;}
.pl-qline .pl-qprog{margin-left:0; white-space:nowrap; min-width:4.6rem; text-align:right;}
.pl-qbar{flex:0 0 5.5rem; height:6px; background:var(--line); position:relative;}
.pl-qbar i{position:absolute; left:0; top:0; bottom:0; background:var(--accent);}
.pl-qline{gap:.6rem; align-items:center;}
.pl-qline small:last-child{margin-left:0; min-width:3.4rem; text-align:right;}
.pl-wquests{border:2px solid var(--line); border-top:none; padding:.3rem .7rem .4rem; margin:-1rem 0 1rem;}
@media (max-width:640px){ .pl-qbar{flex-basis:3.5rem;} }
.pl-gamepage{margin-top:.4rem;}
.pl-hero{display:grid; grid-template-columns:auto minmax(0, 1fr); gap:1.6rem; align-items:center; border:2px solid var(--accent);
  padding:1.4rem 1.6rem; margin-bottom:1.8rem; background:radial-gradient(circle at 10% 50%, #2a1013 0%, #0f0f0f 60%); box-shadow:8px 8px 0 #2a1013;}
.pl-heromedal{width:132px; height:132px;}
.pl-hero .pl-medal.on{filter:drop-shadow(0 0 14px rgba(229,72,75,.75));}
.pl-herolvl{display:flex; align-items:baseline; gap:1rem; flex-wrap:wrap;}
.pl-herolvl b{font-size:2.6rem; letter-spacing:.06em; text-transform:uppercase; color:var(--accent); line-height:1;}
.pl-herorank{font-size:1rem; letter-spacing:.2em; text-transform:uppercase; font-weight:700;}
.pl-herobar{margin:.9rem 0 .4rem;}
.pl-herostats{display:grid; grid-template-columns:repeat(6, minmax(0, 1fr)); gap:.4rem; margin-top:.9rem;}
.pl-herostats span{display:flex; flex-direction:column; border:2px solid var(--line); padding:.45rem .5rem; min-width:0;}
.pl-herostats b{font-size:1rem; font-variant-numeric:tabular-nums; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.pl-herostats small{font-size:.56rem; letter-spacing:.14em; text-transform:uppercase; color:var(--muted);}
@media (max-width:640px){
  .pl-hero{grid-template-columns:minmax(0, 1fr); justify-items:center; text-align:center; padding:1.1rem;}
  .pl-heromedal{width:110px; height:110px;}
  .pl-herolvl{justify-content:center;}
  .pl-herolvl b{font-size:2rem;}
  .pl-herostats{grid-template-columns:repeat(3, minmax(0, 1fr)); width:100%;}
}
.pl-ranks{display:flex; flex-wrap:wrap; gap:.3rem; margin-top:.8rem;}
.pl-rank{display:inline-flex; flex-direction:column; align-items:center; gap:.1rem; border:2px solid var(--line); padding:.25rem .45rem; min-width:4.6rem; color:var(--muted);}
.pl-rank b{font-size:.6rem; letter-spacing:.08em; text-transform:uppercase;}
.pl-rank small{font-size:.52rem;}
.pl-rank.got{color:var(--fg); border-color:var(--fg);}
.pl-rank.cur{background:var(--accent); border-color:var(--accent); color:var(--accent-ink);}
.pl-nextb{display:flex; align-items:baseline; gap:.4rem .8rem; flex-wrap:wrap; margin:.9rem 0 0; font-size:.72rem; color:var(--muted);}
.pl-nextb b{color:var(--fg); text-transform:uppercase; letter-spacing:.06em;}
.pl-bgroup{margin-bottom:1rem;}
.pl-bghead{display:flex; justify-content:space-between; align-items:baseline; font-size:.62rem; letter-spacing:.12em; text-transform:uppercase; color:var(--fg); margin-bottom:.35rem;}
.pl-bghead small{color:var(--muted); font-size:.6rem;}
.pl-badge{position:relative; overflow:hidden; min-height:5.4rem; gap:.25rem;}
/* emblems are pixel icons in the theme's colours: red once earned, dark grey while locked */
.pl-emb{display:block; font-style:normal; line-height:0;}
.pl-emb svg{display:block; width:100%; height:100%;}
/* medallions */
.pl-medal{display:block; position:relative; font-style:normal; line-height:0;}
.pl-medal svg{display:block; width:100%; height:100%; overflow:visible;}
.pl-medal.on{filter:drop-shadow(0 0 4px rgba(229,72,75,.35));}
.pl-medal.on.r3{filter:drop-shadow(0 0 6px rgba(229,72,75,.5));}
.pl-medal.on.r4{filter:drop-shadow(0 0 10px rgba(229,72,75,.7));}
/* a light sweep across earned medallions on hover */
.pl-medal.on::after{content:""; position:absolute; inset:0; pointer-events:none; opacity:0;
  clip-path:polygon(50% 8%, 86.4% 29%, 86.4% 71%, 50% 92%, 13.6% 71%, 13.6% 29%);
  background:linear-gradient(115deg, transparent 35%, rgba(255,255,255,.28) 50%, transparent 65%) no-repeat; background-size:250% 100%; background-position:120% 0;}
.pl-badge:hover .pl-medal.on::after, .pl-rank:hover .pl-medal.on::after{opacity:1; animation:pl-shine .9s ease-out 1;}
@keyframes pl-shine{ from{ background-position:120% 0; } to{ background-position:-120% 0; } }
@media (prefers-reduced-motion:reduce){ .pl-medal.on::after{display:none;} }
.pl-badge{min-height:8.2rem; padding:.55rem .4rem .7rem; justify-content:flex-start;}
.pl-badge .pl-medal{width:62px; height:62px; margin:.1rem 0 .3rem;}
.pl-badge.done{background:#120c0d; border-color:var(--accent); color:var(--fg);}
.pl-badge.done.r4{background:radial-gradient(circle at 50% 30%, #2a1012 0%, #120c0d 70%);}
.pl-badge.done small{color:var(--accent);}
.pl-rar{font-size:.5rem; letter-spacing:.16em; text-transform:uppercase; color:#3a3a3a;}
.pl-badge.done .pl-rar{color:var(--muted);}
.pl-badge.done.r3 .pl-rar{color:var(--fg);}
.pl-badge.done.r4 .pl-rar{color:var(--accent); font-weight:700;}
.pl-rank .pl-medal{width:34px; height:34px; margin-bottom:.2rem;}
.pl-rank{padding:.4rem .45rem .3rem;}
.pl-rank.cur .pl-medal{filter:drop-shadow(0 0 6px rgba(15,15,15,.6));}
.pl-lvlc{display:inline-flex; align-items:center; gap:.8rem;}
.pl-lvlc > span{display:inline-flex; flex-direction:column; line-height:1.1;}
.pl-rname{font-size:.66rem; letter-spacing:.16em; text-transform:uppercase; color:var(--muted);}
.pl-rmedal{width:56px; height:56px;}
.pl-celei.medal{width:130px; height:130px;}
.pl-celei.medal.r4{filter:drop-shadow(0 0 16px rgba(229,72,75,.75));}
.pl-celei.medal.r5{filter:drop-shadow(0 0 22px rgba(229,72,75,.9)) drop-shadow(0 0 4px rgba(231,231,231,.5));}
.pl-medal.on.r5{filter:drop-shadow(0 0 12px rgba(229,72,75,.85)) drop-shadow(0 0 2px rgba(231,231,231,.6));}
.pl-badge.done.r5{background:radial-gradient(circle at 50% 30%, #3a1215 0%, #120c0d 75%); border-width:2px; box-shadow:inset 0 0 0 1px rgba(231,231,231,.25);}
.pl-badge.done.r5 .pl-rar{color:var(--accent-ink); background:var(--accent); padding:.05rem .35rem; font-weight:700;}
.pl-badge.r5:not(.done) .pl-rar{color:#5a2a2c;}
.pl-quest .pl-etag, .pl-qline .pl-etag{font-size:.5rem; letter-spacing:.14em; text-transform:uppercase; color:var(--accent-ink); background:var(--accent); padding:.05rem .3rem; margin-left:.4rem;}
.pl-boss.raid{border-color:var(--accent); box-shadow:inset 0 0 0 1px rgba(229,72,75,.35);}
.pl-boss.raid .pl-nlab{color:var(--accent); font-weight:700;}
.pl-celei.medal.r3{filter:drop-shadow(0 0 10px rgba(229,72,75,.55));}
.pl-nextb .pl-emb{display:inline-block; width:14px; height:14px; color:var(--muted); vertical-align:-2px;}
.pl-remb{display:inline-block; width:14px; height:14px; color:var(--accent);}
.pl-celei{width:76px; height:76px; margin:0 auto .8rem; color:var(--accent);}
.pl-celei svg{display:block; width:100%; height:100%;}
.pl-bprog{position:absolute; left:0; bottom:0; height:3px; background:var(--accent); opacity:.7;}
.pl-credit{margin:-.4rem 0 1.4rem; font-size:.58rem; color:#4a4a4a;}
.pl-credit a{color:inherit;}
.pl-credit a:hover{color:var(--muted);}
/* keyboard focus is always visible */
.pl button:focus-visible, .pl select:focus-visible, .pl input:focus-visible, .pl textarea:focus-visible, .pl [tabindex]:focus-visible{outline:2px solid var(--accent); outline-offset:2px;}
.pl-emptyday{border:2px dashed var(--line); padding:1.2rem; margin-bottom:1rem; display:flex; flex-direction:column; gap:.8rem; align-items:flex-start;}
.pl-emptyday b{font-size:.8rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted);}
/* NOW */
.pl-now{border:2px solid var(--fg); border-left:6px solid var(--ac); padding:.75rem .9rem; display:flex; flex-direction:column; gap:.55rem; margin-top:.2rem;}
.pl-nowrow{display:flex; align-items:baseline; gap:.5rem 1rem; flex-wrap:wrap;}
.pl-nowt{flex:1 1 10rem; min-width:0; background:transparent; border:none; padding:0; font:inherit; color:var(--fg); text-align:left; cursor:pointer;
  font-size:1.35rem; font-weight:700; letter-spacing:.03em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.pl-nowt:hover{color:var(--accent);}
.pl-nowc{font-size:1.35rem; font-weight:700; color:var(--accent); font-variant-numeric:tabular-nums; white-space:nowrap;}
.pl-nowbar{display:block; height:6px; background:var(--line); position:relative;}
.pl-nowbar i{position:absolute; left:0; top:0; bottom:0; background:var(--accent);}
.pl-now small{color:var(--muted); font-size:.66rem;}
.pl-now .pl-nowrow small:last-child{margin-left:auto;}
.pl-now.idle{flex-direction:row; align-items:baseline; flex-wrap:wrap; gap:.4rem 1rem; border-color:var(--line); border-left-color:var(--ac);}
.pl-now.idle .pl-nowt, .pl-now.idle .pl-nowc{font-size:1.05rem;}
.pl-now.idle .pl-nowc{color:var(--fg);}
/* heatmap */
.pl-heat{display:flex; gap:3px; overflow-x:auto; padding-bottom:6px;}
.pl-hcol{display:flex; flex-direction:column; gap:3px;}
.pl-heat i, .pl-hkey i{display:block; width:11px; height:11px; border:1px solid var(--line); box-sizing:border-box;}
.pl-heat i.l1, .pl-hkey i.l1{background:rgba(229,72,75,.28); border-color:transparent;}
.pl-heat i.l2, .pl-hkey i.l2{background:rgba(229,72,75,.52); border-color:transparent;}
.pl-heat i.l3, .pl-hkey i.l3{background:rgba(229,72,75,.76); border-color:transparent;}
.pl-heat i.l4, .pl-hkey i.l4{background:var(--accent); border-color:transparent;}
.pl-heat i.now{outline:2px solid var(--fg); outline-offset:1px;}
.pl-heat i.fut{visibility:hidden;}
.pl-hleg{display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-top:.4rem; font-size:.6rem; color:var(--muted);}
.pl-hkey{display:inline-flex; align-items:center; gap:3px;}
@media (max-width:640px){ .pl-nowt, .pl-nowc{font-size:1.05rem;} }
.pl-slink{background:transparent; border:none; padding:0; font:inherit; letter-spacing:inherit; text-transform:inherit; color:inherit; cursor:pointer;}
.pl-slink:hover{color:var(--accent);}
.pl-mute{background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.7rem; width:1.6rem; height:1.4rem; padding:0; cursor:pointer; line-height:1;}
.pl-mute.off{color:var(--muted); text-decoration:line-through;}
.pl-feel{margin:.6rem 0 .5rem;}
.pl-rw{display:grid; grid-template-columns:minmax(0, 1fr) 6.5rem 7.5rem auto; gap:.4rem; align-items:center; margin-bottom:.35rem;}
.pl-rw .pl-btn{padding:.45rem .5rem; white-space:nowrap;}
.pl-claims{margin-top:.8rem;}
.pl-claims .pl-xpline b{color:var(--muted);}
.pl-confetti{position:fixed; inset:0; pointer-events:none; z-index:500; overflow:hidden;}
.pl-confetti i{position:absolute; top:-14px; width:10px; height:10px; background:var(--accent); animation-name:pl-fall; animation-timing-function:cubic-bezier(.3,.6,.6,1); animation-fill-mode:forwards;}
.pl-confetti i.w{background:var(--fg); width:7px; height:7px;}
@keyframes pl-fall{ to{ transform:translate(var(--dx), 108vh) rotate(var(--r)); } }
.pl-cele{position:fixed; inset:0; z-index:450; background:rgba(15,15,15,.9); display:flex; align-items:center; justify-content:center; cursor:pointer; padding:1rem;}
.pl-celecard{border:2px solid var(--accent); background:var(--bg); padding:2rem 2.4rem; text-align:center; box-shadow:10px 10px 0 var(--accent); max-width:30rem; animation:pl-slam .32s steps(3) 1;}
.pl-celet{font-size:2.6rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--accent); line-height:1.1;}
.pl-celen{margin-top:.7rem; font-size:1.05rem; font-weight:700; text-transform:uppercase; letter-spacing:.06em;}
.pl-celes{margin-top:.6rem; font-size:.78rem; color:var(--muted);}
.pl-celetap{margin-top:1.2rem; font-size:.6rem; letter-spacing:.14em; text-transform:uppercase; color:var(--line);}
@keyframes pl-slam{ from{ transform:scale(1.35); } to{ transform:none; } }
@media (prefers-reduced-motion:reduce){ .pl-celecard{animation:none;} }
@media (max-width:640px){ .pl-rw{grid-template-columns:minmax(0, 1fr) 4.6rem; } .pl-rw .pl-btn{grid-column:1;} .pl-celet{font-size:1.9rem;} }
@media (max-width:1100px){
  .pl-day{grid-template-columns:minmax(0, 1fr);}
  .pl-week{grid-template-columns:repeat(4, minmax(0, 1fr));}
}
@media (max-width:640px){
  .pl-wk{gap:.25rem;}
  .pl-wkc{height:2.8rem; font-size:.6rem;}
  .pl-stats{flex-direction:column; align-items:flex-start; gap:.4rem;}
  .pl-fgrid{grid-template-columns:repeat(2, minmax(0, 1fr));}
  .pl-navlabel{min-width:0; font-size:.85rem;}
  .pl-week{grid-template-columns:minmax(0, 1fr);}
  .pl-col{min-height:0;}
  .pl-wi{font-size:.7rem; padding:.35rem .4rem;}
  .pl-focus{grid-template-columns:minmax(0, 1fr);}
  .pl-arow{grid-template-columns:auto minmax(0, 1fr) 4.5rem; }
  .pl-arow select{grid-column:2 / -1;}
  .pl-srow{grid-template-columns:repeat(2, minmax(0, 1fr));}
  .pl-grid{--g0:2.9rem; --g1:.9rem;}
  .pl-agenda .pl-task small{display:none;}
  .pl-keys{grid-template-columns:repeat(2, minmax(0, 1fr));}
  .pl-key{font-size:.66rem; padding:.35rem .4rem;}
  .pl-atime{min-width:5.2rem;}
}
`;
var style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

// the whole site's game: every planner page (the first is the main one), trackers a planner
// doesn't keep (+20 xp a ticked box) and money logged on Finance pages (+15 xp a day)
function score(src, GM){
  // planners are expected cleaned by normalize(); anything else is cleaned here first
  var pages = (src.planners || []).filter(function(pg){ return pg && pg.planner; }).map(function(pg){
    return pg.planner.v === 1 && pg.planner.areas && pg.planner.settings ? pg : { id:pg.id, planner:normalize(pg.planner) };
  });
  if(!pages.length) return null;
  var t = today(), finDays = {}, hasFin = (src.finances || []).length > 0;
  (src.finances || []).forEach(function(f){ arr(f && f.txns).forEach(function(x){ if(isDate(x.date) && x.date <= t) finDays[x.date] = 1; }); });
  var cores = pages.map(function(pg){ return mount({ page:pg, headless:true, game:GM }); });
  var others = cores.slice(1).map(function(c){ return c.parts({ main:false }); });
  var focusExtra = {};
  others.forEach(function(o){ Object.keys(o.focusDay).forEach(function(k){ focusExtra[k] = (focusExtra[k] || 0) + o.focusDay[k]; }); });
  var main = cores[0].parts({ main:true, focusExtra:focusExtra, financeDays:hasFin ? finDays : null });
  var extra = { events:[], ticks:0, finDays:0, finRun:0 };
  (src.trackers || []).forEach(function(tr){
    if(!isDate(tr.start)) return;
    for(var i = 0; i < Math.min(tr.n || 0, (tr.days || []).length); i++){
      if(!tr.days[i]) continue;
      var d = addDays(tr.start, i);
      if(d > t) continue;
      extra.ticks++;
      extra.events.push({ key:"t:" + tr.id + ":" + i, date:d, xp:20, label:"ticked " + (tr.title || "a tracker") + " day " + (i + 1) });
    }
  });
  var fds = Object.keys(finDays).sort(), runN = 0, prev = null;
  fds.forEach(function(d){
    extra.events.push({ key:"m:" + d, date:d, xp:15, label:"logged money" });
    runN = prev && addDays(prev, 1) === d ? runN + 1 : 1; prev = d;
    if(runN > extra.finRun) extra.finRun = runN;
  });
  extra.finDays = fds.length;
  return cores[0].finish(main, others, extra);
}
function medalHTML(icon, rarity){ return medalSvg(icon, rarity, true); }
// index.html opens a planner on a given day from a tracker's Day card
function show(pageId, date){
  var u = uiState[pageId] || (uiState[pageId] = { view:"day", date:today(), form:null, tplSave:false, flash:"", qarea:"personal" });
  u.view = "day"; if(isDate(date)) u.date = date; u.form = null;
}
window.Planner = { lockQuests:lockQuests, needsLock:needsLock, normalize:normalize, fresh:fresh, mount:mount, countDays:countDays, daySummary:daySummary, show:show,
  dayItems:dayItems, tick:tick, score:score, normGame:normGame, mergeGames:mergeGames, medalHTML:medalHTML, mountGame:function(ctx){ var c = {}; Object.keys(ctx).forEach(function(k){ c[k] = ctx[k]; }); c.gameOnly = true; return mount(c); },
  // exposed for tests
  _test:{ addDays:addDays, monday:monday, wd:wd, parseHm:parseHm, parseQuick:parseQuick } };
})();
