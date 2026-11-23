// finance.js: the Finance page type.
//
// index.html owns storage, sync, undo and the page shell; this file only knows a
// page's `finance` object:
//   Finance.normalize(f)   validate saved data (loading, importing, sync)
//   Finance.fresh()        an empty finance object with default categories
//   Finance.mount(ctx)     draw the page into ctx.root; ctx = { root, page, save }
//
// Money is integers in a currency's minor unit (cents for USD, riel for KHR).
// The page has one primary currency. A transaction in another currency keeps
// its own amount, and, if you gave an exchange rate, `base`: its value in the
// primary currency, computed once with exact integer math and never recomputed,
// so history never shifts. Without a rate it is shown separately, never added.
(function(){
"use strict";

// ---------- constants ----------
var CURRENCIES = {
  USD:{ dec:2, name:"US dollar" },   KHR:{ dec:0, name:"Cambodian riel" },
  EUR:{ dec:2, name:"Euro" },        GBP:{ dec:2, name:"British pound" },
  THB:{ dec:2, name:"Thai baht" },   VND:{ dec:0, name:"Vietnamese dong" },
  SGD:{ dec:2, name:"Singapore dollar" }, AUD:{ dec:2, name:"Australian dollar" },
  JPY:{ dec:0, name:"Japanese yen" }, CNY:{ dec:2, name:"Chinese yuan" }
};
var DEFAULT_EXPENSE = ["Food","Transportation","Housing","Bills & Utilities","Internet & Phone","Shopping",
  "Entertainment","Health","Education","Subscriptions","Personal Care","Other Expenses"];
var DEFAULT_INCOME = ["Salary","Freelance","Business","Other Income"];
var DEFAULT_METHODS = ["Cash","Bank","Card"];
var MAX = 1e13;            // far beyond any real amount, still exact as a JS number
var PER_PAGE = 20;

// ---------- small helpers ----------
function rid(){ return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function str(v, max){ return String(v == null ? "" : v).slice(0, max); }
function isDate(s){
  if(typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(+s.slice(0,4), +s.slice(5,7) - 1, +s.slice(8,10));
  return d.getMonth() === +s.slice(5,7) - 1 && d.getDate() === +s.slice(8,10);
}
function isAmount(n){ return Number.isInteger(n) && n > 0 && n < MAX; }
function isYm(s){ return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s); }
function isRate(s){ return typeof s === "string" && /^\d{1,9}(\.\d{1,8})?$/.test(s) && /[1-9]/.test(s); }
function pad(n){ return (n < 10 ? "0" : "") + n; }
function today(){ var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function thisMonth(){ return today().slice(0, 7); }
function addMonths(ym, k){
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + k;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + "-" + pad(m + 1);
}
var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function monthLabel(ym){ return MONTHS[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4); }
function monShort(ym){ return MON[+ym.slice(5, 7) - 1] + (ym.slice(0, 4) !== thisMonth().slice(0, 4) ? " " + ym.slice(2, 4) : ""); }
function shortDate(d){ return +d.slice(8, 10) + " " + MON[+d.slice(5, 7) - 1] + (d.slice(0, 4) !== thisMonth().slice(0, 4) ? " " + d.slice(0, 4) : ""); }

// ---------- data ----------
function cat(name, kind){ return { id:rid(), name:name, kind:kind }; }
function defaultCats(){
  return DEFAULT_EXPENSE.map(function(n){ return cat(n, "expense"); })
    .concat(DEFAULT_INCOME.map(function(n){ return cat(n, "income"); }));
}
function fresh(){
  return { v:2, currency:"USD", categories:defaultCats(), methods:DEFAULT_METHODS.slice(), rates:{},
           txns:[], budgets:{}, goals:[], recurring:[], accounts:[] };
}
function normalize(f){
  f = (f && typeof f === "object") ? f : {};
  var out = { v:2, currency: CURRENCIES[f.currency] ? f.currency : "USD" };
  var P = out.currency;

  var seen = {};
  out.categories = (Array.isArray(f.categories) ? f.categories : []).filter(function(c){
    return c && typeof c.name === "string" && c.name.trim() && (c.kind === "income" || c.kind === "expense");
  }).map(function(c){
    var o = { id:str(c.id || rid(), 40), name:str(c.name.trim(), 40), kind:c.kind };
    if(seen[o.id]) o.id = rid();
    seen[o.id] = 1;
    return o;
  });
  if(!out.categories.length) out.categories = defaultCats();

  var ms = {};
  out.methods = (Array.isArray(f.methods) ? f.methods : []).map(function(m){ return str(m, 30).trim(); })
    .filter(function(m){ if(!m || ms[m.toLowerCase()]) return false; ms[m.toLowerCase()] = 1; return true; });
  if(!out.methods.length) out.methods = DEFAULT_METHODS.slice();

  out.rates = {};
  if(f.rates && typeof f.rates === "object") Object.keys(f.rates).forEach(function(k){
    if(CURRENCIES[k] && k !== P && isRate(f.rates[k])) out.rates[k] = f.rates[k];
  });

  var ids = {};
  out.txns = (Array.isArray(f.txns) ? f.txns : []).filter(function(t){
    return t && (t.type === "income" || t.type === "expense" || t.type === "transfer") && isDate(t.date) && isAmount(t.amount);
  }).map(function(t){
    var o = { id:str(t.id || rid(), 40), type:t.type, date:t.date, amount:t.amount,
              currency: CURRENCIES[t.currency] ? t.currency : P,
              // step 1 stored the description in `note`
              desc:str(t.desc != null ? t.desc : t.note, 120), notes:str(t.notes, 500),
              method:str(t.method, 30),
              // a stable creation time; old records get their date at noon
              createdAt: Number.isInteger(t.createdAt) && t.createdAt > 0 ? t.createdAt
                         : new Date(+t.date.slice(0,4), +t.date.slice(5,7) - 1, +t.date.slice(8,10), 12).getTime() };
    if(o.type === "transfer") o.to = str(t.to, 30);
    else o.categoryId = str(t.categoryId, 40);
    if(o.currency !== P && isRate(t.rate) && Number.isInteger(t.base) && t.base >= 0 && t.base < MAX){
      o.rate = t.rate; o.base = t.base;
    }
    if(t.recurringId) o.recurringId = str(t.recurringId, 40);
    return o;
  }).filter(function(t){
    // one record per id, so an import or sync can never double a transaction
    if(ids[t.id]) return false; ids[t.id] = 1; return true;
  });

  out.budgets = {};
  if(f.budgets && typeof f.budgets === "object") Object.keys(f.budgets).forEach(function(ym){
    var b = f.budgets[ym];
    if(!isYm(ym) || !b || typeof b !== "object") return;
    var o = { cats:{} };
    if(isAmount(b.limit)) o.limit = b.limit;
    if(b.cats && typeof b.cats === "object") Object.keys(b.cats).forEach(function(id){
      if(isAmount(b.cats[id])) o.cats[str(id, 40)] = b.cats[id];
    });
    out.budgets[ym] = o;
  });

  // reserved for later features; kept untouched so nothing is lost
  out.goals = Array.isArray(f.goals) ? f.goals : [];
  out.recurring = Array.isArray(f.recurring) ? f.recurring : [];
  out.accounts = Array.isArray(f.accounts) ? f.accounts : [];
  return out;
}

// ---------- money ----------
var fmtCache = {};
function money(code, minor, signed){
  var c = CURRENCIES[code];
  if(!fmtCache[code]) fmtCache[code] = new Intl.NumberFormat("en-US",
    { style:"currency", currency:code, minimumFractionDigits:c.dec, maximumFractionDigits:c.dec });
  var s = fmtCache[code].format(Math.abs(minor) / Math.pow(10, c.dec));
  if(minor < 0) return "−" + s;
  return signed && minor > 0 ? "+" + s : s;
}
// "1,234.56", "$12", "12.5" -> minor units, rounded half up; NaN if not a
// positive number (anything with a minus sign is rejected)
function parseMoney(s, dec){
  s = String(s);
  if(s.indexOf("-") >= 0 || s.indexOf("−") >= 0) return NaN;   // a minus is never silently dropped
  s = s.replace(/[\s,]/g, "").replace(/^[^\d.]+/, "");
  if(!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return NaN;
  var parts = s.split("."), whole = parts[0] || "0", frac = parts[1] || "", up = 0;
  if(frac.length > dec){ up = +frac.charAt(dec) >= 5 ? 1 : 0; frac = frac.slice(0, dec); }
  while(frac.length < dec) frac += "0";
  return parseInt(whole + frac, 10) + up;
}
function toInput(code, minor){
  var dec = CURRENCIES[code].dec;
  if(!dec) return String(minor);
  var s = String(minor).padStart(dec + 1, "0");
  return s.slice(0, -dec) + "." + s.slice(-dec);
}
// rate means "1 primary = rate units of the other currency".
// value in primary minor units = amount / 10^decT / rate * 10^decP, rounded
// half up, done in BigInt so nothing is lost to floats.
function convert(amountMinor, fromCode, rate, primary){
  var parts = rate.split("."), scale = (parts[1] || "").length;
  var r = BigInt(parts[0] + (parts[1] || "")), ten = BigInt(10);
  var num = BigInt(amountMinor) * ten ** BigInt(CURRENCIES[primary].dec) * ten ** BigInt(scale);
  var den = ten ** BigInt(CURRENCIES[fromCode].dec) * r;
  return Number((BigInt(2) * num + den) / (BigInt(2) * den));
}
// a transaction's value in the primary currency, or null if it can't be counted
function pv(f, t){ return t.currency === f.currency ? t.amount : (t.base != null ? t.base : null); }

// totals for income/expense in the primary currency; transfers never count.
// `skipped` collects anything in another currency without a rate.
function sum(f, match){
  var inc = 0, exp = 0, skipped = {};
  f.txns.forEach(function(t){
    if(t.type === "transfer" || !match(t)) return;
    var v = pv(f, t);
    if(v == null){ var s = skipped[t.currency] || (skipped[t.currency] = { inc:0, exp:0 }); s[t.type === "income" ? "inc" : "exp"] += t.amount; return; }
    if(t.type === "income") inc += v; else exp += v;
  });
  return { inc:inc, exp:exp, net:inc - exp, rate: inc > 0 ? (inc - exp) / inc * 100 : null, skipped:skipped };
}
function monthSum(f, ym){ return sum(f, function(t){ return t.date.slice(0, 7) === ym; }); }
function catSpend(f, match){
  var by = {}, total = 0;
  f.txns.forEach(function(t){
    if(t.type !== "expense" || !match(t)) return;
    var v = pv(f, t); if(v == null) return;
    by[t.categoryId] = (by[t.categoryId] || 0) + v; total += v;
  });
  return { by:by, total:total };
}
// the budget in force for a month: its own, else the latest earlier one
function budgetFor(f, ym){
  if(f.budgets[ym]) return { b:f.budgets[ym], from:ym };
  var keys = Object.keys(f.budgets).filter(function(k){ return k < ym; }).sort();
  return keys.length ? { b:f.budgets[keys[keys.length - 1]], from:keys[keys.length - 1] } : { b:null, from:null };
}
function firstMonth(f){
  var m = null;
  f.txns.forEach(function(t){ var k = t.date.slice(0, 7); if(!m || k < m) m = k; });
  return m;
}

// ---------- tiny DOM helper ----------
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
// one tooltip for every chart
var tip = null;
function showTip(e, lines){
  if(!tip){ tip = h("div", { class:"fin-tip", role:"status" }); document.body.appendChild(tip); }
  tip.innerHTML = "";
  lines.forEach(function(l, i){ tip.appendChild(h("div", { class:i ? "" : "fin-tip-h", text:l })); });
  tip.hidden = false;
  var x = e.clientX + 14, y = e.clientY + 14, w = tip.offsetWidth, hh = tip.offsetHeight;
  if(x + w > window.innerWidth - 8) x = e.clientX - w - 14;
  if(y + hh > window.innerHeight - 8) y = e.clientY - hh - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
function hideTip(){ if(tip) tip.hidden = true; }
window.addEventListener("scroll", hideTip, true);

// ---------- the page ----------
var uiState = {};     // view state per page id; survives redraws and undo
function mount(ctx){
  var p = ctx.page, f = p.finance, root = ctx.root;
  var u = uiState[p.id] || (uiState[p.id] = { view:"overview", month:thisMonth(), scope:"month", q:"", type:"",
    cat:"", sort:"date", dir:-1, pg:0, form:null, period:"12", catDel:null });
  var m$ = function(minor, signed){ return money(f.currency, minor, signed); };
  function catById(id){ for(var i = 0; i < f.categories.length; i++) if(f.categories[i].id === id) return f.categories[i]; return null; }
  function catName(id){ var c = catById(id); return c ? c.name : "uncategorized"; }
  function commit(){ ctx.save(); draw(); }
  hideTip();

  var body = null;
  function draw(){
    hideTip();
    root.innerHTML = "";
    root.appendChild(toolbar());
    root.appendChild(tabs());
    if(u.form) root.appendChild(form());
    body = h("div", { class:"fin-body" });
    root.appendChild(body);
    ({ overview:overview, transactions:transactions, budgets:budgets, analytics:analytics, settings:settings }[u.view] || overview)();
  }

  // ----- month switcher, quick add, tabs -----
  function toolbar(){
    var isNow = u.month === thisMonth();
    return h("div", { class:"fin-bar" }, [
      h("div", { class:"fin-month" }, [
        h("button", { type:"button", class:"fin-nav", "aria-label":"previous month", text:"‹",
          onclick:function(){ u.month = addMonths(u.month, -1); u.pg = 0; draw(); } }),
        h("span", { class:"fin-mlabel", text:monthLabel(u.month) }),
        h("button", { type:"button", class:"fin-nav", "aria-label":"next month", text:"›",
          onclick:function(){ u.month = addMonths(u.month, 1); u.pg = 0; draw(); } }),
        isNow ? null : h("button", { type:"button", class:"fin-link", text:"this month",
          onclick:function(){ u.month = thisMonth(); u.pg = 0; draw(); } })
      ]),
      h("div", { class:"fin-actions" }, [
        h("button", { type:"button", class:"fin-btn", text:"+ income", onclick:function(){ openForm("income"); } }),
        h("button", { type:"button", class:"fin-btn fin-primary", text:"+ expense", onclick:function(){ openForm("expense"); } })
      ])
    ]);
  }
  function tabs(){
    return h("div", { class:"fin-tabs", role:"tablist" }, ["overview","transactions","budgets","analytics","settings"].map(function(v){
      return h("button", { type:"button", role:"tab", class:"fin-tab" + (u.view === v ? " on" : ""), "aria-selected":u.view === v ? "true" : "false",
        text:v, onclick:function(){ u.view = v; u.pg = 0; draw(); } });
    }));
  }
  function section(title, kids, extra){
    return h("section", { class:"fin-sec" }, [ h("div", { class:"fin-shead" }, [ h("h3", { class:"fin-h", text:title }), extra || null ]) ].concat(kids));
  }
  function skippedNote(skipped){
    var keys = Object.keys(skipped);
    if(!keys.length) return null;
    return h("p", { class:"fin-skip" }, [ "not counted (no exchange rate): " + keys.map(function(k){
      var s = skipped[k], parts = [];
      if(s.inc) parts.push("in " + money(k, s.inc));
      if(s.exp) parts.push("out " + money(k, s.exp));
      return parts.join(", ");
    }).join(" · ") + ". edit them to add a rate." ]);
  }

  // ===== OVERVIEW =====
  function delta(cur, prev, goodWhenUp, points){
    if(points){
      if(cur == null || prev == null) return h("span", { class:"fin-delta", text:prev == null ? "no income last month" : "" });
      var d = Math.round((cur - prev) * 10) / 10;
      if(!d) return h("span", { class:"fin-delta", text:"same as last month" });
      return h("span", { class:"fin-delta " + ((d > 0) === goodWhenUp ? "good" : "bad"),
        text:(d > 0 ? "▲ " : "▼ ") + Math.abs(d) + " pts vs last month" });
    }
    if(!prev && !cur) return h("span", { class:"fin-delta", text:"" });
    if(!prev) return h("span", { class:"fin-delta", text:"nothing last month" });
    var pct = Math.round((cur - prev) / Math.abs(prev) * 100);
    if(!pct) return h("span", { class:"fin-delta", text:"same as last month" });
    return h("span", { class:"fin-delta " + ((cur > prev) === goodWhenUp ? "good" : "bad"),
      text:(cur > prev ? "▲ " : "▼ ") + Math.abs(pct) + "% vs last month" });
  }
  function tile(label, value, sub, cls){
    return h("div", { class:"fin-tile" + (cls ? " " + cls : "") }, [
      h("div", { class:"fin-tlabel", text:label }), h("div", { class:"fin-tval", text:value }), sub ]);
  }
  function tiles(t, pv){
    return h("div", { class:"fin-tiles" }, [
      tile("total income", m$(t.inc), delta(t.inc, pv.inc, true)),
      tile("total expenses", m$(t.exp), delta(t.exp, pv.exp, false)),
      tile("net cash flow", m$(t.net), delta(t.net, pv.net, true), t.net < 0 ? "neg" : ""),
      tile("savings rate", t.rate == null ? "—" : (Math.round(t.rate * 10) / 10) + "%",
        t.rate == null ? h("span", { class:"fin-delta", text:"no income this month" }) : delta(t.rate, pv.rate, true, true),
        t.rate != null && t.rate < 0 ? "neg" : "")
    ]);
  }
  function bar(pct, over){
    return h("span", { class:"fin-pbar" + (over ? " over" : "") }, [ h("i", { style:"width:" + Math.min(100, Math.max(0, pct)) + "%" }) ]);
  }
  function overview(){
    var t = monthSum(f, u.month), prev = monthSum(f, addMonths(u.month, -1));
    body.appendChild(h("section", { class:"fin-sec" }, [ tiles(t, prev), skippedNote(t.skipped) ]));

    // spending progress against the monthly limit
    var bf = budgetFor(f, u.month);
    if(bf.b && bf.b.limit){
      var lim = bf.b.limit, pct = t.exp / lim * 100, over = t.exp > lim;
      body.appendChild(section("spending this month", [
        h("div", { class:"fin-limit" }, [
          h("div", { class:"fin-limrow" }, [
            h("span", null, [ h("b", { text:m$(t.exp) }), " of " + m$(lim) + " limit" ]),
            h("span", { class:over ? "fin-red" : "", text: over ? m$(t.exp - lim) + " over" : m$(lim - t.exp) + " left" })
          ]),
          bar(pct, over),
          h("div", { class:"fin-limsub", text:Math.round(pct) + "% used" + (bf.from !== u.month ? " · limit carried over from " + monthLabel(bf.from) : "") })
        ])
      ]));
    }else{
      body.appendChild(h("p", { class:"fin-hint" }, [ "no monthly spending limit yet. ",
        h("button", { type:"button", class:"fin-link", text:"set one in budgets", onclick:function(){ u.view = "budgets"; draw(); } }) ]));
    }

    body.appendChild(section("what stands out", [ insights(t, prev, bf) ]));

    var grid = h("div", { class:"fin-two" });
    var months = []; for(var i = 5; i >= 0; i--) months.push(addMonths(u.month, -i));
    grid.appendChild(section("income vs expenses · 6 months", [ incExpChart(months) ]));
    grid.appendChild(section("where it went · " + monShort(u.month), [ catBars(catSpend(f, function(x){ return x.date.slice(0, 7) === u.month; })) ]));
    body.appendChild(grid);

    var recent = f.txns.slice().sort(function(a, b){ return a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt; }).slice(0, 6);
    body.appendChild(section("recent transactions", [
      recent.length ? txTable(recent, false) : emptyBox("no transactions yet", "add your first income or expense with the buttons above.")
    ], f.txns.length ? h("button", { type:"button", class:"fin-link", text:"all transactions ›", onclick:function(){ u.view = "transactions"; draw(); } }) : null));
  }

  // plain-language observations about the selected month
  function insights(t, prev, bf){
    var out = [];
    if(!t.inc && !t.exp){ return h("p", { class:"fin-hint", text:"nothing recorded in " + monthLabel(u.month) + " yet." }); }
    if(t.inc){
      out.push(t.net >= 0
        ? "you kept " + m$(t.net) + " of your " + m$(t.inc) + " income (" + Math.round(t.rate) + "%)."
        : "you spent " + m$(-t.net) + " more than you earned.");
    }else out.push("no income recorded this month, so everything spent came from savings.");
    var cs = catSpend(f, function(x){ return x.date.slice(0, 7) === u.month; });
    var top = Object.keys(cs.by).sort(function(a, b){ return cs.by[b] - cs.by[a]; })[0];
    if(top) out.push("your biggest expense is " + catName(top) + ": " + m$(cs.by[top]) + " (" + Math.round(cs.by[top] / cs.total * 100) + "% of spending).");
    if(prev.exp){
      var d = Math.round((t.exp - prev.exp) / prev.exp * 100);
      if(d) out.push("spending is " + (d > 0 ? "up " : "down ") + Math.abs(d) + "% compared with " + monthLabel(addMonths(u.month, -1)) + ".");
      else out.push("spending is level with " + monthLabel(addMonths(u.month, -1)) + ".");
    }
    if(bf.b){
      var overs = [], near = [];
      Object.keys(bf.b.cats).forEach(function(id){
        if(!catById(id)) return;
        var s = cs.by[id] || 0, b = bf.b.cats[id];
        if(s > b) overs.push(catName(id)); else if(s >= b * 0.8) near.push(catName(id));
      });
      if(overs.length) out.push("over budget: " + overs.join(", ") + ".");
      if(near.length) out.push("close to the limit (80%+): " + near.join(", ") + ".");
      if(!overs.length && !near.length && Object.keys(bf.b.cats).length) out.push("every category budget is on track.");
    }
    return h("ul", { class:"fin-insights" }, out.map(function(s){
      return h("li", { class:/^over budget|more than you earned/.test(s) ? "bad" : "", text:s });
    }));
  }

  // ----- charts (hand-built, no library) -----
  // grouped bars: income in the light ink, expenses in the accent red
  function incExpChart(months){
    var data = months.map(function(ym){ var s = monthSum(f, ym); return { ym:ym, inc:s.inc, exp:s.exp }; });
    var max = 0; data.forEach(function(d){ max = Math.max(max, d.inc, d.exp); });
    if(!max) return emptyBox("no data in these months", "the chart fills in as you add transactions.");
    var cols = data.map(function(d){
      var col = h("div", { class:"fin-col" + (d.ym === u.month ? " cur" : ""), tabindex:"0",
        "aria-label":monthLabel(d.ym) + ": income " + m$(d.inc) + ", expenses " + m$(d.exp) }, [
        h("div", { class:"fin-colbars" }, [
          h("i", { class:"inc", style:"height:" + (d.inc / max * 100) + "%" }),
          h("i", { class:"exp", style:"height:" + (d.exp / max * 100) + "%" })
        ]),
        h("span", { class:"fin-collab", text:monShort(d.ym) })
      ]);
      var lines = [monthLabel(d.ym), "income " + m$(d.inc), "expenses " + m$(d.exp), "net " + m$(d.inc - d.exp)];
      col.addEventListener("pointermove", function(e){ showTip(e, lines); });
      col.addEventListener("pointerleave", hideTip);
      col.addEventListener("click", function(){ u.month = d.ym; draw(); });
      return col;
    });
    return h("div", { class:"fin-chart" }, [
      h("div", { class:"fin-legend" }, [ h("span", null, [ h("i", { class:"inc" }), "income" ]), h("span", null, [ h("i", { class:"exp" }), "expenses" ]),
        h("span", { class:"fin-max", text:"max " + m$(max) }) ]),
      h("div", { class:"fin-cols" }, cols)
    ]);
  }
  function catBars(cs){
    var ids = Object.keys(cs.by).sort(function(a, b){ return cs.by[b] - cs.by[a]; });
    if(!ids.length) return emptyBox("no spending here", "expenses show up here by category.");
    var max = cs.by[ids[0]];
    return h("div", { class:"fin-cats" }, ids.map(function(id){
      return h("div", { class:"fin-crow" }, [
        h("span", { class:"fin-cname", text:catName(id) }),
        h("span", { class:"fin-cbar" }, [ h("i", { style:"width:" + (cs.by[id] / max * 100) + "%" }) ]),
        h("span", { class:"fin-camt", text:m$(cs.by[id]) }),
        h("span", { class:"fin-cpct", text:Math.round(cs.by[id] / cs.total * 100) + "%" })
      ]);
    }));
  }
  // savings rate per month as a line (its own chart: % and money never share an axis)
  function rateChart(rows){
    var pts = rows.filter(function(r){ return r.rate != null; });
    if(pts.length < 2) return h("p", { class:"fin-hint", text:"needs income in at least two months." });
    var lo = Math.min(0, Math.min.apply(null, pts.map(function(r){ return r.rate; })));
    var hi = Math.max(100, Math.max.apply(null, pts.map(function(r){ return r.rate; })));
    var n = rows.length, X = function(i){ return n === 1 ? 50 : i / (n - 1) * 100; }, Y = function(v){ return (hi - v) / (hi - lo) * 100; };
    var path = "", started = false;
    rows.forEach(function(r, i){
      if(r.rate == null){ started = false; return; }
      path += (started ? " L" : " M") + X(i).toFixed(2) + " " + Y(r.rate).toFixed(2); started = true;
    });
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
    var zero = document.createElementNS(svg.namespaceURI, "line");
    zero.setAttribute("x1", 0); zero.setAttribute("x2", 100); zero.setAttribute("y1", Y(0)); zero.setAttribute("y2", Y(0));
    zero.setAttribute("class", "zero"); svg.appendChild(zero);
    var line = document.createElementNS(svg.namespaceURI, "path");
    line.setAttribute("d", path); svg.appendChild(line);
    var plot = h("div", { class:"fin-rplot" }, [ svg ]);
    rows.forEach(function(r, i){
      if(r.rate == null) return;
      var dot = h("span", { class:"fin-dot" + (r.rate < 0 ? " neg" : ""), tabindex:"0", style:"left:" + X(i) + "%;top:" + Y(r.rate) + "%",
        "aria-label":monthLabel(r.ym) + ": saved " + Math.round(r.rate) + "%" });
      var lines = [monthLabel(r.ym), "savings rate " + (Math.round(r.rate * 10) / 10) + "%", "net " + m$(r.net)];
      dot.addEventListener("pointermove", function(e){ showTip(e, lines); });
      dot.addEventListener("pointerleave", hideTip);
      plot.appendChild(dot);
    });
    plot.appendChild(h("span", { class:"fin-raxis top", text:Math.round(hi) + "%" }));
    plot.appendChild(h("span", { class:"fin-raxis zero", style:"top:" + Y(0) + "%", text:"0%" }));
    return h("div", { class:"fin-rchart" }, [ plot, h("div", { class:"fin-rlabs" }, rows.map(function(r){ return h("span", { text:monShort(r.ym) }); })) ]);
  }
  function emptyBox(title, text){
    return h("div", { class:"fin-empty" }, [ h("b", { text:title }), h("span", { text:text }) ]);
  }

  // ===== TRANSACTIONS =====
  function txAmount(t){
    if(t.type === "transfer") return money(t.currency, t.amount);
    return money(t.currency, t.type === "income" ? t.amount : -t.amount, true);
  }
  function txTable(rows, full){
    function th(k, label, cls){
      if(!full || !k) return h("th", { class:cls || "", scope:"col", text:label });
      return h("th", { class:(cls || "") + (u.sort === k ? " sorted" : ""), scope:"col" }, [
        h("button", { type:"button", text:label + (u.sort === k ? (u.dir > 0 ? " ↑" : " ↓") : ""),
          onclick:function(){ if(u.sort === k) u.dir = -u.dir; else { u.sort = k; u.dir = (k === "date" || k === "amount") ? -1 : 1; } u.pg = 0; draw(); } }) ]);
    }
    return h("div", { class:"fin-twrap" }, [ h("table", { class:"fin-table" }, [
      h("thead", null, [ h("tr", null, [ th("date", "date"), th("desc", "description"), th("category", "category"),
        th("", "type"), th("amount", "amount", "num"), h("th", { class:"act", text:"" }) ]) ]),
      h("tbody", null, rows.map(function(t){
        var del = armed(h("button", { type:"button", class:"fin-act", "aria-label":"delete", text:"×" }), "sure?", function(){
          f.txns = f.txns.filter(function(x){ return x.id !== t.id; }); commit();
        });
        var v = pv(f, t);
        var amtCell = h("td", { "data-l":"amount", class:"num amt" }, [ txAmount(t),
          t.currency !== f.currency ? h("small", { class:"fin-conv", text: v == null ? "no rate" : "≈ " + m$(v) }) : null ]);
        var desc = t.desc || (t.type === "transfer" ? "transfer" : catName(t.categoryId));
        return h("tr", { class:t.type }, [
          h("td", { "data-l":"date", title:t.date, text:shortDate(t.date) }),
          h("td", { "data-l":"description", class:"desc" }, [ desc,
            t.notes ? h("small", { class:"fin-notes", text:t.notes }) : null,
            h("small", { class:"fin-meth", text: t.type === "transfer" ? (t.method || "?") + " → " + (t.to || "?") : t.method }) ]),
          h("td", { "data-l":"category", text: t.type === "transfer" ? "—" : catName(t.categoryId) }),
          h("td", { "data-l":"type", text:t.type }),
          amtCell,
          h("td", { class:"act" }, [
            h("button", { type:"button", class:"fin-act", "aria-label":"edit", text:"✎",
              onclick:function(){ openForm(t.type, t); } }), del ])
        ]);
      }))
    ]) ]);
  }
  function transactions(){
    var q = u.q.trim().toLowerCase();
    var rows = f.txns.filter(function(t){
      if(u.scope === "month" && t.date.slice(0, 7) !== u.month) return false;
      if(u.type && t.type !== u.type) return false;
      if(u.cat && t.categoryId !== u.cat) return false;
      if(q){
        var hay = [t.desc, t.notes, t.type === "transfer" ? "" : catName(t.categoryId), t.method, t.to || "", t.type, t.date,
                   money(t.currency, t.amount), toInput(t.currency, t.amount), t.currency].join(" ").toLowerCase();
        if(hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = {
      date:function(t){ return t.date + "|" + String(t.createdAt).padStart(15, "0"); },
      desc:function(t){ return (t.desc || "").toLowerCase(); },
      category:function(t){ return t.type === "transfer" ? "" : catName(t.categoryId).toLowerCase(); },
      amount:function(t){ var v = pv(f, t); v = v == null ? 0 : v; return t.type === "income" ? v : t.type === "expense" ? -v : 0; }
    }[u.sort] || function(t){ return t.date; };
    rows.sort(function(a, b){
      var x = key(a), y = key(b);
      if(x < y) return -u.dir; if(x > y) return u.dir;
      return b.createdAt - a.createdAt;
    });
    var tot = sum(f, function(t){ return rows.indexOf(t) >= 0; });
    var transfers = rows.filter(function(t){ return t.type === "transfer"; }).length;
    var pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    if(u.pg >= pages) u.pg = pages - 1;
    var shown = rows.slice(u.pg * PER_PAGE, (u.pg + 1) * PER_PAGE);

    var search = h("input", { type:"search", class:"fin-in fin-search", placeholder:"search…", value:u.q, "aria-label":"search transactions",
      oninput:function(){ u.q = search.value; u.pg = 0; draw(); var s = root.querySelector(".fin-search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
    function sel(label, val, opts, set){
      var s = h("select", { class:"fin-in fin-filter", "aria-label":label }, opts.map(function(o){ return h("option", { value:o[0], text:o[1] }); }));
      s.value = val; s.addEventListener("change", function(){ set(s.value); u.pg = 0; draw(); });
      return s;
    }
    var cats = f.categories.slice().sort(function(a, b){ return a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "expense" ? -1 : 1; });
    body.appendChild(h("div", { class:"fin-filters" }, [
      search,
      sel("period", u.scope, [["month", monthLabel(u.month)], ["all", "all time"]], function(v){ u.scope = v; }),
      sel("type", u.type, [["", "all types"], ["income", "income"], ["expense", "expenses"], ["transfer", "transfers"]], function(v){ u.type = v; }),
      sel("category", u.cat, [["", "all categories"]].concat(cats.map(function(c){ return [c.id, c.name]; })), function(v){ u.cat = v; })
    ]));
    if(!f.txns.length){ body.appendChild(emptyBox("no transactions yet", "add your first income or expense with the buttons above.")); return; }
    if(!rows.length){ body.appendChild(emptyBox("nothing matches", u.scope === "month" ? "nothing in " + monthLabel(u.month) + " with these filters." : "try a different search or filter.")); return; }
    body.appendChild(txTable(shown, true));
    body.appendChild(h("div", { class:"fin-tfoot" }, [
      h("span", null, [ rows.length + (rows.length === 1 ? " transaction" : " transactions") + " · in ", h("b", { text:m$(tot.inc) }),
        " · out ", h("b", { text:m$(tot.exp) }), " · net ", h("b", { class:tot.net < 0 ? "neg" : "", text:m$(tot.net) }),
        transfers ? " · " + transfers + (transfers === 1 ? " transfer" : " transfers") + " (not counted)" : "" ]),
      pages > 1 ? h("span", { class:"fin-pager" }, [
        h("button", { type:"button", class:"fin-nav", text:"‹", disabled:u.pg === 0, "aria-label":"previous page", onclick:function(){ u.pg--; draw(); } }),
        h("span", { text:(u.pg * PER_PAGE + 1) + "–" + Math.min(rows.length, (u.pg + 1) * PER_PAGE) + " of " + rows.length }),
        h("button", { type:"button", class:"fin-nav", text:"›", disabled:u.pg >= pages - 1, "aria-label":"next page", onclick:function(){ u.pg++; draw(); } })
      ]) : null
    ]));
    var sk = skippedNote(tot.skipped); if(sk) body.appendChild(sk);
  }

  // ----- add / edit form -----
  function openForm(type, t){
    var inMonth = u.month === thisMonth();
    u.form = t ? { id:t.id, type:t.type, amount:toInput(t.currency, t.amount), currency:t.currency, rate:t.rate || f.rates[t.currency] || "",
                   date:t.date, cat:t.categoryId || "", method:t.method, to:t.to || "", desc:t.desc, notes:t.notes, showNotes:!!t.notes }
               : { type:type, amount:"", currency:f.currency, rate:"", date: inMonth ? today() : u.month + "-01", cat:"",
                   method:f.methods[0] || "", to:f.methods[1] || f.methods[0] || "", desc:"", notes:"", showNotes:false };
    draw();
    var a = root.querySelector(".fin-form .fin-amount"); if(a){ a.focus(); a.scrollIntoView({ block:"nearest" }); }
  }
  function closeForm(){ u.form = null; draw(); }
  function form(){
    var fm = u.form, editing = !!fm.id, isTr = fm.type === "transfer";
    var msg = h("div", { class:"fin-msg", role:"alert" });
    var dec = function(){ return CURRENCIES[fm.currency].dec; };

    var amt = h("input", { type:"text", class:"fin-in fin-amount", inputmode:"decimal", placeholder: dec() ? "0.00" : "0",
      value:fm.amount, "aria-label":"amount", oninput:function(){ fm.amount = amt.value; preview(); } });
    var cur = h("select", { class:"fin-in fin-cur", "aria-label":"currency" },
      Object.keys(CURRENCIES).map(function(k){ return h("option", { value:k, text:k }); }));
    cur.value = fm.currency;
    cur.addEventListener("change", function(){ fm.currency = cur.value; fm.rate = f.rates[fm.currency] || ""; draw(); root.querySelector(".fin-amount").focus(); });
    var foreign = fm.currency !== f.currency;
    var rate = h("input", { type:"text", class:"fin-in", inputmode:"decimal", value:fm.rate, placeholder:"e.g. 4100",
      "aria-label":"exchange rate", oninput:function(){ fm.rate = rate.value.trim(); preview(); } });
    var conv = h("small", { class:"fin-convprev" });
    function preview(){
      if(!foreign){ conv.textContent = ""; return; }
      var minor = parseMoney(amt.value, dec()), r = rate.value.trim();
      conv.textContent = (minor > 0 && isRate(r)) ? "≈ " + m$(convert(minor, fm.currency, r, f.currency)) + " (fixed at this rate)"
                       : "leave empty to keep it separate from " + f.currency + " totals";
    }
    var date = h("input", { type:"date", class:"fin-in", value:fm.date, "aria-label":"date", onchange:function(){ fm.date = date.value; } });
    var desc = h("input", { type:"text", class:"fin-in", maxlength:"120", placeholder: isTr ? "e.g. ATM withdrawal" : "e.g. lunch, rent, salary",
      value:fm.desc, "aria-label":"description", oninput:function(){ fm.desc = desc.value; } });

    var cats = f.categories.filter(function(c){ return c.kind === fm.type; });
    if(!isTr && (!fm.cat || !catById(fm.cat) || catById(fm.cat).kind !== fm.type)) fm.cat = cats.length ? cats[0].id : "";
    var newCat = h("input", { type:"text", class:"fin-in fin-newcat", placeholder:"new category name", maxlength:"40", hidden:true });
    var catSel = h("select", { class:"fin-in", "aria-label":"category" },
      cats.map(function(c){ return h("option", { value:c.id, text:c.name }); }).concat([h("option", { value:"__new", text:"+ new category…" })]));
    catSel.value = fm.cat;
    catSel.addEventListener("change", function(){ newCat.hidden = catSel.value !== "__new"; if(!newCat.hidden) newCat.focus(); else fm.cat = catSel.value; });

    function methodSel(val, label, set){
      var opts = f.methods.slice(); if(val && opts.indexOf(val) < 0) opts.push(val);
      var s = h("select", { class:"fin-in", "aria-label":label }, opts.map(function(m){ return h("option", { value:m, text:m }); })
        .concat([h("option", { value:"__new", text:"+ new method…" })]));
      s.value = val;
      var nm = h("input", { type:"text", class:"fin-in", placeholder:"new method name", maxlength:"30", hidden:true });
      s.addEventListener("change", function(){ nm.hidden = s.value !== "__new"; if(!nm.hidden) nm.focus(); else set(s.value); });
      return { sel:s, input:nm, value:function(){
        if(s.value !== "__new") return s.value;
        var v = nm.value.trim().slice(0, 30);
        if(v && !f.methods.some(function(m){ return m.toLowerCase() === v.toLowerCase(); })) f.methods.push(v);
        return v;
      } };
    }
    var from = methodSel(fm.method, isTr ? "from" : "payment method", function(v){ fm.method = v; });
    var to = isTr ? methodSel(fm.to, "to", function(v){ fm.to = v; }) : null;
    var notes = h("textarea", { class:"fin-in fin-notesin", rows:"2", maxlength:"500", placeholder:"optional note",
      "aria-label":"notes", oninput:function(){ fm.notes = notes.value; } });
    notes.value = fm.notes;

    function submit(){
      var minor = parseMoney(amt.value, dec());
      if(!(minor > 0)){ msg.textContent = "enter an amount above zero"; amt.focus(); return; }
      if(minor >= MAX){ msg.textContent = "that amount is too large"; amt.focus(); return; }
      if(!isDate(date.value)){ msg.textContent = "pick a valid date"; date.focus(); return; }
      var r = foreign ? rate.value.trim() : "";
      if(foreign && r && !isRate(r)){ msg.textContent = "the rate must be a number above zero, like 4100"; rate.focus(); return; }
      var rec = { type:fm.type, date:date.value, amount:minor, currency:fm.currency, desc:desc.value.trim().slice(0, 120),
                  notes:notes.value.trim().slice(0, 500) };
      if(isTr){
        rec.method = from.value(); rec.to = to.value();
        if(!rec.method || !rec.to){ msg.textContent = "pick both payment methods"; return; }
        if(rec.method === rec.to){ msg.textContent = "a transfer needs two different methods"; return; }
      }else{
        rec.method = from.value();
        var catId = catSel.value;
        if(catId === "__new"){
          var nm = newCat.value.trim();
          if(!nm){ msg.textContent = "name the new category"; newCat.focus(); return; }
          var ex = f.categories.filter(function(c){ return c.kind === fm.type && c.name.toLowerCase() === nm.toLowerCase(); })[0];
          if(ex) catId = ex.id; else { var c = cat(nm.slice(0, 40), fm.type); f.categories.push(c); catId = c.id; }
        }
        rec.categoryId = catId;
      }
      if(foreign && r){ rec.rate = r; rec.base = convert(minor, fm.currency, r, f.currency); f.rates[fm.currency] = r; }
      if(editing){
        var t = f.txns.filter(function(x){ return x.id === fm.id; })[0];
        if(t){
          // keep id and createdAt; replace everything else so stale fields can't linger
          ["categoryId","to","rate","base"].forEach(function(k){ delete t[k]; });
          Object.keys(rec).forEach(function(k){ t[k] = rec[k]; });
        }
      }else{ rec.id = rid(); rec.createdAt = Date.now(); f.txns.push(rec); }
      u.form = null;
      u.month = rec.date.slice(0, 7);         // show the month it landed in
      commit();
    }
    [amt, rate, desc, newCat, from.input].concat(to ? [to.input] : []).forEach(function(i){
      i.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); submit(); } if(e.key === "Escape") closeForm(); });
    });
    notes.addEventListener("keydown", function(e){ if(e.key === "Escape") closeForm(); });
    var typeBtn = function(t){
      return h("button", { type:"button", class:"fin-tog" + (fm.type === t ? " on" : ""), text:t,
        onclick:function(){ fm.type = t; fm.cat = ""; draw(); root.querySelector(".fin-amount").focus(); } });
    };
    preview();
    return h("section", { class:"fin-sec fin-form" }, [
      h("div", { class:"fin-fhead" }, [
        h("span", { class:"fin-h", text: editing ? "edit transaction" : "new transaction" }),
        h("span", { class:"fin-toggle" }, [ typeBtn("expense"), typeBtn("income"), typeBtn("transfer") ])
      ]),
      h("div", { class:"fin-grid" }, [
        h("label", { class:"amt" }, [ "amount", h("span", { class:"fin-amtrow" }, [ amt, cur ]) ]),
        h("label", null, [ "date", date ]),
        isTr ? h("label", null, [ "from", from.sel, from.input ]) : h("label", null, [ "category", catSel, newCat ]),
        isTr ? h("label", null, [ "to", to.sel, to.input ])
             : h("label", null, [ fm.type === "income" ? "received via" : "paid with", from.sel, from.input ]),
        foreign ? h("label", { class:"wide" }, [ "exchange rate: 1 " + f.currency + " = ? " + fm.currency, rate, conv ]) : null,
        h("label", { class:"wide" }, [ "description", desc ]),
        fm.showNotes ? h("label", { class:"wide" }, [ "notes", notes ])
                     : h("button", { type:"button", class:"fin-link wide", text:"+ add a note", onclick:function(){ fm.showNotes = true; draw(); } })
      ]),
      isTr ? h("p", { class:"fin-hint", text:"transfers move money between your own methods and never count as income or spending." }) : null,
      msg,
      h("div", { class:"fin-frow" }, [
        h("button", { type:"button", class:"fin-btn fin-primary", text: editing ? "save changes" : "add " + fm.type, onclick:submit }),
        h("button", { type:"button", class:"fin-btn fin-ghost", text:"cancel", onclick:closeForm })
      ])
    ]);
  }

  // ===== BUDGETS =====
  function budgets(){
    var bf = budgetFor(f, u.month), own = bf.from === u.month;
    var b = bf.b || { cats:{} };
    var cs = catSpend(f, function(t){ return t.date.slice(0, 7) === u.month; });
    var t = monthSum(f, u.month);
    // editing an inherited budget saves a copy for this month first
    function edit(fn){
      if(!f.budgets[u.month]) f.budgets[u.month] = JSON.parse(JSON.stringify(bf.b || { cats:{} }));
      fn(f.budgets[u.month]); commit();
    }
    function amountInput(val, label, onset){
      var i = h("input", { type:"text", class:"fin-in fin-bin", inputmode:"decimal", placeholder:"no budget", "aria-label":label,
        value: val ? toInput(f.currency, val) : "" });
      function apply(){
        var v = i.value.trim();
        if(!v){ onset(0); return; }
        var minor = parseMoney(v, CURRENCIES[f.currency].dec);
        if(!(minor >= 0) || minor >= MAX){ i.classList.add("bad"); return; }
        onset(minor);
      }
      i.addEventListener("change", apply);
      i.addEventListener("keydown", function(e){ if(e.key === "Enter") i.blur(); });
      return i;
    }
    var status = own ? (Object.keys(f.budgets).length ? "set for " + monthLabel(u.month) + "." : "")
                     : bf.from ? "carried over from " + monthLabel(bf.from) + ". changing anything saves a copy for " + monthLabel(u.month) + "."
                               : "no budgets yet. type amounts below; they carry over to later months until you change them.";
    body.appendChild(h("p", { class:"fin-hint", text:status + " amounts in " + f.currency + "." }));

    // monthly limit
    var lim = b.limit || 0, over = lim && t.exp > lim;
    body.appendChild(section("monthly spending limit", [
      h("div", { class:"fin-brow head" }, [ h("span", { text:"" }), h("span", { text:"budget" }), h("span", { text:"spent" }),
        h("span", { text:"left" }), h("span", { text:"used" }), h("span", { text:"" }) ]),
      h("div", { class:"fin-brow" + (over ? " over" : "") }, [
        h("span", { class:"fin-bname", text:"all spending" }),
        amountInput(lim, "monthly limit", function(v){ edit(function(x){ if(v) x.limit = v; else delete x.limit; }); }),
        h("span", { class:"num", text:m$(t.exp) }),
        h("span", { class:"num" + (over ? " fin-red" : ""), text: lim ? m$(lim - t.exp) : "—" }),
        h("span", { class:"num", text: lim ? Math.round(t.exp / lim * 100) + "%" : "—" }),
        lim ? bar(t.exp / lim * 100, over) : h("span")
      ])
    ]));

    // per category
    var exp = f.categories.filter(function(c){ return c.kind === "expense"; });
    var rows = exp.map(function(c){
      var bud = b.cats[c.id] || 0, spent = cs.by[c.id] || 0, o = bud && spent > bud;
      return h("div", { class:"fin-brow" + (o ? " over" : "") }, [
        h("span", { class:"fin-bname", text:c.name }),
        amountInput(bud, c.name + " budget", function(v){ edit(function(x){ if(v) x.cats[c.id] = v; else delete x.cats[c.id]; }); }),
        h("span", { class:"num", text:spent ? m$(spent) : "—" }),
        h("span", { class:"num" + (o ? " fin-red" : ""), text: bud ? m$(bud - spent) : "—" }),
        h("span", { class:"num", text: bud ? Math.round(spent / bud * 100) + "%" : "—" }),
        bud ? bar(spent / bud * 100, o) : h("span")
      ]);
    });
    var budgeted = exp.reduce(function(s, c){ return s + (b.cats[c.id] || 0); }, 0);
    body.appendChild(section("category budgets", [
      h("div", { class:"fin-brow head" }, [ h("span", { text:"category" }), h("span", { text:"budget" }), h("span", { text:"spent" }),
        h("span", { text:"left" }), h("span", { text:"used" }), h("span", { text:"" }) ])
    ].concat(rows).concat([
      h("p", { class:"fin-hint", text:"category budgets add up to " + m$(budgeted) + (lim ? (budgeted > lim ? ", more than the monthly limit." : " of the " + m$(lim) + " limit.") : ".") })
    ])));
    if(own && bf.b && Object.keys(f.budgets).some(function(k){ return k < u.month; })){
      body.appendChild(h("button", { type:"button", class:"fin-link", text:"use the previous month's budgets instead",
        onclick:function(){ delete f.budgets[u.month]; commit(); } }));
    }
  }

  // ===== ANALYTICS =====
  function analytics(){
    var end = thisMonth() > u.month ? u.month : thisMonth();
    var first = firstMonth(f);
    var periods = [["6", "last 6 months"], ["12", "last 12 months"], ["year", "this year"], ["all", "all time"]];
    var sel = h("select", { class:"fin-in fin-filter", "aria-label":"period" }, periods.map(function(o){ return h("option", { value:o[0], text:o[1] }); }));
    sel.value = u.period; sel.addEventListener("change", function(){ u.period = sel.value; draw(); });
    var start = u.period === "6" ? addMonths(end, -5) : u.period === "12" ? addMonths(end, -11)
              : u.period === "year" ? end.slice(0, 4) + "-01" : (first && first < end ? first : end);
    var months = []; for(var m = start; m <= end; m = addMonths(m, 1)) months.push(m);
    body.appendChild(h("div", { class:"fin-filters" }, [ h("span", { class:"fin-hint", text:"ending " + monthLabel(end) + " · " }), sel ]));
    if(!f.txns.length){ body.appendChild(emptyBox("no data yet", "analytics appear once you add transactions.")); return; }

    var rows = months.map(function(ym){ var s = monthSum(f, ym); return { ym:ym, inc:s.inc, exp:s.exp, net:s.net, rate:s.rate }; });
    var withData = rows.filter(function(r){ return r.inc || r.exp; });
    var tot = rows.reduce(function(a, r){ a.inc += r.inc; a.exp += r.exp; return a; }, { inc:0, exp:0 });
    var n = withData.length || 1;
    body.appendChild(h("div", { class:"fin-tiles" }, [
      tile("income in period", m$(tot.inc), h("span", { class:"fin-delta", text:"avg " + m$(Math.round(tot.inc / n)) + " a month" })),
      tile("expenses in period", m$(tot.exp), h("span", { class:"fin-delta", text:"avg " + m$(Math.round(tot.exp / n)) + " a month" })),
      tile("saved in period", m$(tot.inc - tot.exp), h("span", { class:"fin-delta", text: tot.inc ? Math.round((tot.inc - tot.exp) / tot.inc * 100) + "% of income" : "" }),
        tot.inc - tot.exp < 0 ? "neg" : ""),
      tile("months with data", String(withData.length), h("span", { class:"fin-delta", text:"of " + rows.length }))
    ]));
    body.appendChild(section("income vs expenses", [ incExpChart(months) ]));
    var grid = h("div", { class:"fin-two" });
    grid.appendChild(section("savings rate by month", [ rateChart(rows) ]));
    var cs = catSpend(f, function(t){ var k = t.date.slice(0, 7); return k >= start && k <= end; });
    grid.appendChild(section("spending by category", [ catBars(cs) ]));
    body.appendChild(grid);
    // the same numbers as a table
    body.appendChild(section("month by month", [ h("div", { class:"fin-twrap" }, [ h("table", { class:"fin-table fin-mtable" }, [
      h("thead", null, [ h("tr", null, ["month","income","expenses","net","saved"].map(function(x, i){ return h("th", { class:i ? "num" : "", scope:"col", text:x }); })) ]),
      h("tbody", null, rows.slice().reverse().map(function(r){
        return h("tr", null, [ h("td", { "data-l":"month", text:monthLabel(r.ym) }), h("td", { "data-l":"income", class:"num", text:m$(r.inc) }),
          h("td", { "data-l":"expenses", class:"num", text:m$(r.exp) }), h("td", { "data-l":"net", class:"num" + (r.net < 0 ? " fin-red" : ""), text:m$(r.net) }),
          h("td", { "data-l":"saved", class:"num", text:r.rate == null ? "—" : Math.round(r.rate) + "%" }) ]);
      }))
    ]) ]) ]));
  }

  // ===== SETTINGS =====
  function settings(){
    var locked = f.txns.length > 0;
    var cur = h("select", { class:"fin-in", disabled:locked, "aria-label":"primary currency" },
      Object.keys(CURRENCIES).map(function(k){ return h("option", { value:k, text:k + " · " + CURRENCIES[k].name }); }));
    cur.value = f.currency;
    cur.addEventListener("change", function(){ f.currency = cur.value; delete f.rates[f.currency]; commit(); });
    var rateRows = Object.keys(f.rates).map(function(k){
      var i = h("input", { type:"text", class:"fin-in", inputmode:"decimal", value:f.rates[k], "aria-label":k + " rate" });
      i.addEventListener("change", function(){ var v = i.value.trim(); if(isRate(v)){ f.rates[k] = v; commit(); } else i.value = f.rates[k]; });
      return h("div", { class:"fin-srow" }, [ h("span", { class:"fin-rlab", text:"1 " + f.currency + " =" }), i, h("span", { class:"fin-rlab", text:k }) ]);
    });

    function catList(kind){
      var list = f.categories.filter(function(c){ return c.kind === kind; });
      var add = h("input", { type:"text", class:"fin-in", maxlength:"40", placeholder:"+ add a category" });
      add.addEventListener("keydown", function(e){
        if(e.key !== "Enter") return;
        var nm = add.value.trim();
        if(!nm || list.some(function(c){ return c.name.toLowerCase() === nm.toLowerCase(); })) return;
        f.categories.push(cat(nm, kind)); commit();
      });
      var kids = [ h("div", { class:"fin-slabel", text:kind === "expense" ? "expense categories" : "income categories" }) ];
      list.forEach(function(c){
        var used = f.txns.filter(function(t){ return t.categoryId === c.id; }).length;
        var name = h("input", { type:"text", class:"fin-in", maxlength:"40", value:c.name, "aria-label":"category name" });
        name.addEventListener("change", function(){ var v = name.value.trim(); if(v){ c.name = v; commit(); } else name.value = c.name; });
        function remove(target){
          f.txns.forEach(function(t){ if(t.categoryId === c.id) t.categoryId = target; });
          Object.keys(f.budgets).forEach(function(ym){
            var bc = f.budgets[ym].cats;
            if(bc[c.id]){ if(target) bc[target] = (bc[target] || 0) + bc[c.id]; delete bc[c.id]; }
          });
          f.categories = f.categories.filter(function(x){ return x !== c; });
          if(u.cat === c.id) u.cat = "";
          u.catDel = null; commit();
        }
        var del;
        if(used) del = h("button", { type:"button", class:"fin-act", text:"×", "aria-label":"delete category",
          onclick:function(){ u.catDel = u.catDel === c.id ? null : c.id; draw(); } });
        else del = armed(h("button", { type:"button", class:"fin-act", text:"×", "aria-label":"delete category" }), "sure?", function(){ remove(null); });
        kids.push(h("div", { class:"fin-srow" }, [ name, h("span", { class:"fin-used", title:"transactions in this category", text:used ? String(used) : "" }), del ]));
        if(u.catDel === c.id){
          // a used category is never just deleted: its transactions move first
          var others = list.filter(function(x){ return x !== c; });
          var target = h("select", { class:"fin-in", "aria-label":"move to" }, others.map(function(x){ return h("option", { value:x.id, text:x.name }); })
            .concat([h("option", { value:"__new", text:"a new \"" + (kind === "expense" ? "Other Expenses" : "Other Income") + "\" category" })]));
          kids.push(h("div", { class:"fin-reassign" }, [
            h("span", { text:"move its " + used + (used === 1 ? " transaction" : " transactions") + " (and budgets) to" }), target,
            h("button", { type:"button", class:"fin-btn fin-primary", text:"move & delete", onclick:function(){
              var id = target.value;
              if(id === "__new"){ var nc = cat(kind === "expense" ? "Other Expenses" : "Other Income", kind); f.categories.push(nc); id = nc.id; }
              remove(id);
            } }),
            h("button", { type:"button", class:"fin-btn fin-ghost", text:"cancel", onclick:function(){ u.catDel = null; draw(); } })
          ]));
        }
      });
      kids.push(add);
      return h("div", { class:"fin-slist" }, kids);
    }
    var addM = h("input", { type:"text", class:"fin-in", maxlength:"30", placeholder:"+ add a method" });
    addM.addEventListener("keydown", function(e){
      if(e.key !== "Enter") return;
      var v = addM.value.trim();
      if(!v || f.methods.some(function(m){ return m.toLowerCase() === v.toLowerCase(); })) return;
      f.methods.push(v); commit();
    });
    var methods = h("div", { class:"fin-slist" }, [ h("div", { class:"fin-slabel", text:"payment methods" }) ]
      .concat(f.methods.map(function(m, i){
        var name = h("input", { type:"text", class:"fin-in", maxlength:"30", value:m, "aria-label":"method name" });
        name.addEventListener("change", function(){
          var v = name.value.trim();
          if(!v){ name.value = m; return; }
          f.txns.forEach(function(t){ if(t.method === m) t.method = v; if(t.to === m) t.to = v; });   // renaming follows through
          f.methods[i] = v; commit();
        });
        var del = armed(h("button", { type:"button", class:"fin-act", text:"×", "aria-label":"delete method" }), "sure?", function(){
          f.methods.splice(i, 1); commit();   // past transactions keep the name
        });
        return h("div", { class:"fin-srow" }, [ name, h("span", { class:"fin-used" }), del ]);
      })).concat([addM]));
    body.appendChild(section("currency", [
      h("label", { class:"fin-cur" }, [ "primary currency", cur,
        h("small", { text: locked ? "locked once you have transactions: changing it would relabel amounts without converting them."
                                  : "all totals and budgets use this currency. pick it before adding transactions." }) ]),
      rateRows.length ? h("div", { class:"fin-slist fin-rates" }, [ h("div", { class:"fin-slabel", text:"last exchange rates you used (suggested for new entries; past ones never change)" }) ].concat(rateRows)) : null
    ]));
    body.appendChild(section("categories & methods", [ h("div", { class:"fin-scols" }, [ catList("expense"), catList("income"), methods ]) ]));
  }

  draw();
}

// ---------- styles (same tokens as index.html) ----------
var css = `
.fin{margin-top:.5rem;}
.fin-sec{margin-bottom:1.6rem; min-width:0;}
.fin-bar{display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:1rem;}
.fin-month{display:flex; align-items:center; gap:.6rem;}
.fin-mlabel{font-size:1.05rem; font-weight:700; letter-spacing:.1em; text-transform:uppercase; min-width:11.5rem; text-align:center;}
.fin-nav{background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; width:2rem; height:2rem; cursor:pointer; line-height:1;}
.fin-nav:hover:not(:disabled){border-color:var(--fg);}
.fin-nav:disabled{opacity:.3; cursor:default;}
.fin-link{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.66rem; letter-spacing:.12em; text-transform:uppercase; cursor:pointer; padding:0; text-align:left;}
.fin-link:hover{color:var(--accent);}
.fin-actions{display:flex; gap:.4rem; flex-wrap:wrap;}
.fin-btn{background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.7rem; letter-spacing:.1em; text-transform:uppercase; padding:.5rem .8rem; cursor:pointer;}
.fin-btn:hover{border-color:var(--fg);}
.fin-btn.fin-primary{border-color:var(--accent); color:var(--accent);}
.fin-btn.fin-primary:hover{background:var(--accent); color:var(--accent-ink);}
.fin-btn.fin-ghost{color:var(--muted);}
.fin-tabs{display:flex; gap:0; border-bottom:2px solid var(--fg); margin-bottom:1.4rem; overflow-x:auto;}
.fin-tabs{scrollbar-width:none;}
.fin-tabs::-webkit-scrollbar{display:none;}
.fin-tab{background:transparent; border:2px solid transparent; border-bottom:none; color:var(--muted); font:inherit; font-size:.68rem;
  letter-spacing:.12em; text-transform:uppercase; padding:.55rem .85rem; cursor:pointer; white-space:nowrap;}
.fin-tab:hover{color:var(--fg);}
.fin-tab.on{color:var(--accent-ink); background:var(--fg); border-color:var(--fg);}
.fin-tiles{display:grid; grid-template-columns:repeat(4, 1fr); gap:.6rem; margin-bottom:1rem;}
.fin-tile{border:2px solid var(--line); padding:.8rem .9rem .75rem; min-width:0;}
.fin-tlabel{font-size:.6rem; letter-spacing:.14em; text-transform:uppercase; color:var(--muted);}
.fin-tval{font-size:1.45rem; font-weight:700; margin:.3rem 0 .25rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-variant-numeric:tabular-nums;}
.fin-tile.neg .fin-tval{color:var(--accent);}
.fin-delta{display:block; min-height:1em; font-size:.6rem; letter-spacing:.06em; color:var(--muted);}
.fin-delta.good{color:var(--fg);}
.fin-delta.bad{color:var(--accent);}
.fin-red, b.neg{color:var(--accent);}
.fin-skip{margin:.2rem 0 0; font-size:.68rem; color:var(--accent);}
.fin-hint{margin:0 0 .8rem; font-size:.7rem; color:var(--muted); letter-spacing:.03em; line-height:1.6;}
.fin-shead{display:flex; justify-content:space-between; align-items:baseline; gap:1rem; margin-bottom:.6rem;}
.fin-h{display:block; margin:0; font-size:.66rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted);}
.fin-two{display:grid; grid-template-columns:1fr 1fr; gap:1.4rem;}
.fin-limit{border:2px solid var(--line); padding:.8rem .9rem;}
.fin-limrow{display:flex; justify-content:space-between; gap:1rem; font-size:.8rem; margin-bottom:.5rem;}
.fin-limsub{margin-top:.4rem; font-size:.62rem; color:var(--muted); letter-spacing:.06em;}
.fin-pbar{display:block; height:12px; border:2px solid var(--fg); position:relative;}
.fin-pbar i{position:absolute; left:0; top:0; bottom:0; background:var(--fg);}
.fin-pbar.over{border-color:var(--accent);}
.fin-pbar.over i{background:var(--accent);}
.fin-insights{margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:.35rem; font-size:.78rem;}
.fin-insights li{padding-left:1.1rem; position:relative; line-height:1.5;}
.fin-insights li::before{content:"→"; position:absolute; left:0; color:var(--muted);}
.fin-insights li.bad{color:var(--accent);}
.fin-chart{border:2px solid var(--line); padding:.7rem .8rem 1.6rem;}
.fin-legend{display:flex; gap:1rem; align-items:center; font-size:.62rem; letter-spacing:.08em; color:var(--muted); margin-bottom:.6rem; text-transform:uppercase;}
.fin-legend span{display:inline-flex; align-items:center; gap:.35rem;}
.fin-legend i{display:inline-block; width:10px; height:10px;}
.fin-legend i.inc, .fin-colbars i.inc{background:var(--fg);}
.fin-legend i.exp, .fin-colbars i.exp{background:var(--accent);}
.fin-legend .fin-max{margin-left:auto; text-transform:none; letter-spacing:.02em;}
.fin-cols{display:flex; align-items:stretch; gap:.4rem; height:170px; border-bottom:2px solid var(--fg);}
.fin-col{flex:1 1 0; display:flex; flex-direction:column; min-width:0; cursor:pointer; outline:none; position:relative;}
.fin-col:hover, .fin-col:focus-visible{background:#161616;}
.fin-col.cur{background:#151515;}
.fin-colbars{flex:1 1 auto; display:flex; align-items:flex-end; justify-content:center; gap:2px; padding:0 12%;}
.fin-colbars i{display:block; flex:1 1 0; max-width:18px; min-height:0;}
.fin-collab{position:absolute; bottom:-1.35rem; left:0; right:0; text-align:center; font-size:.58rem; color:var(--muted); white-space:nowrap;}
.fin-col.cur .fin-collab{color:var(--fg); font-weight:700;}
.fin-tip{position:fixed; z-index:200; pointer-events:none; background:var(--bg); border:2px solid var(--fg); padding:.4rem .55rem;
  font-family:var(--mono); font-size:.68rem; box-shadow:4px 4px 0 var(--line); font-variant-numeric:tabular-nums;}
.fin-tip-h{font-weight:700; letter-spacing:.08em; text-transform:uppercase; margin-bottom:.15rem;}
.fin-rchart{border:2px solid var(--line); padding:.8rem .9rem .5rem 2.6rem;}
.fin-rplot{position:relative; height:140px;}
.fin-rplot svg{position:absolute; inset:0; width:100%; height:100%; overflow:visible;}
.fin-rplot path{fill:none; stroke:var(--fg); stroke-width:2; vector-effect:non-scaling-stroke;}
.fin-rplot line.zero{stroke:var(--line); stroke-width:2; vector-effect:non-scaling-stroke;}
.fin-dot{position:absolute; width:10px; height:10px; margin:-5px 0 0 -5px; background:var(--fg); border:2px solid var(--bg); cursor:pointer;}
.fin-dot.neg{background:var(--accent);}
.fin-raxis{position:absolute; left:-2.4rem; font-size:.56rem; color:var(--muted); transform:translateY(-50%);}
.fin-raxis.top{top:0;}
.fin-rlabs{display:flex; justify-content:space-between; margin-top:.4rem; font-size:.56rem; color:var(--muted);}
.fin-cats{display:flex; flex-direction:column; gap:.35rem;}
.fin-crow{display:grid; grid-template-columns:8.5rem 1fr 6.2rem 2.6rem; align-items:center; gap:.6rem; font-size:.74rem;}
.fin-cname{overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.fin-cbar{height:10px; border:2px solid var(--line); position:relative;}
.fin-cbar i{position:absolute; left:0; top:0; bottom:0; background:var(--accent);}
.fin-camt{text-align:right; font-variant-numeric:tabular-nums;}
.fin-cpct{text-align:right; color:var(--muted);}
.fin-form{border:2px solid var(--fg); padding:1rem; box-shadow:6px 6px 0 var(--line);}
.fin-fhead{display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:.8rem;}
.fin-toggle{display:flex;}
.fin-tog{background:transparent; border:2px solid var(--line); color:var(--muted); font:inherit; font-size:.66rem; letter-spacing:.12em; text-transform:uppercase; padding:.35rem .7rem; cursor:pointer;}
.fin-tog + .fin-tog{border-left:none;}
.fin-tog.on{border-color:var(--accent); background:var(--accent); color:var(--accent-ink);}
.fin-grid{display:grid; grid-template-columns:repeat(4, 1fr); gap:.6rem;}
.fin-grid label, .fin-cur{display:flex; flex-direction:column; gap:.3rem; font-size:.58rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); min-width:0;}
.fin-grid .wide{grid-column:1 / -1;}
.fin-amtrow{display:flex; gap:0;}
.fin-amtrow .fin-amount{flex:1 1 auto; min-width:0;}
.fin-amtrow .fin-cur{flex:0 0 4.6rem; border-left:none; padding:.45rem .3rem;}
.fin-in{width:100%; background:var(--bg); border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.8rem; padding:.45rem .5rem; outline:none; border-radius:0; color-scheme:dark; letter-spacing:0; text-transform:none;}
.fin-in:focus{border-color:var(--accent);}
.fin-in:disabled{color:var(--muted);}
.fin-in.bad{border-color:var(--accent);}
textarea.fin-in{resize:vertical; min-height:2.6rem;}
.fin-amount{font-size:1rem; font-weight:700; font-variant-numeric:tabular-nums;}
select.fin-in{cursor:pointer;}
.fin-convprev{text-transform:none; letter-spacing:0; font-size:.68rem; color:var(--fg);}
.fin-msg{min-height:1.1em; margin:.6rem 0 .2rem; font-size:.7rem; color:var(--accent);}
.fin-frow{display:flex; gap:.4rem;}
.fin-filters{display:flex; gap:.4rem; flex-wrap:wrap; align-items:center; margin-bottom:.8rem;}
.fin-filters .fin-hint{margin:0;}
.fin-search{flex:1 1 14rem; max-width:22rem;}
.fin-filter{width:auto; font-size:.72rem; padding:.4rem .4rem;}
.fin-twrap{overflow-x:auto;}
.fin-table{width:100%; border-collapse:collapse; font-size:.76rem;}
.fin-table th{text-align:left; border-bottom:2px solid var(--fg); padding:.45rem .5rem; font-size:.6rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); font-weight:400;}
.fin-table th button{background:transparent; border:none; color:inherit; font:inherit; letter-spacing:inherit; text-transform:inherit; padding:0; cursor:pointer;}
.fin-table th.sorted, .fin-table th button:hover{color:var(--fg);}
.fin-table td{border-bottom:2px solid var(--line); padding:.5rem; vertical-align:top; white-space:nowrap;}
.fin-table td.desc{white-space:normal; min-width:10rem;}
.fin-table td small{display:block; color:var(--muted); font-size:.62rem; margin-top:.15rem; white-space:normal;}
.fin-table .num{text-align:right; font-variant-numeric:tabular-nums;}
.fin-table tr.expense .amt{color:var(--accent);}
.fin-table tr.income .amt{color:var(--fg); font-weight:700;}
.fin-table tr.transfer .amt{color:var(--muted);}
.fin-table tbody tr:hover td{background:#141414;}
.fin-table .act{width:4.5rem; text-align:right;}
.fin-act{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.85rem; cursor:pointer; padding:.1rem .3rem;}
.fin-act:hover{color:var(--fg);}
.fin-act.armed{color:var(--accent); font-size:.6rem; letter-spacing:.08em; text-transform:uppercase;}
.fin-tfoot{display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-top:.7rem; font-size:.68rem; color:var(--muted); letter-spacing:.04em;}
.fin-tfoot b{color:var(--fg);}
.fin-tfoot b.neg{color:var(--accent);}
.fin-pager{display:flex; align-items:center; gap:.5rem;}
.fin-empty{border:2px dashed var(--line); padding:1.2rem; display:flex; flex-direction:column; gap:.35rem; font-size:.74rem; color:var(--muted);}
.fin-empty b{color:var(--fg); font-size:.74rem; letter-spacing:.1em; text-transform:uppercase;}
.fin-brow{display:grid; grid-template-columns:minmax(7rem,1.3fr) 7rem 6rem 6rem 3.2rem minmax(5rem,1fr); gap:.6rem; align-items:center;
  font-size:.76rem; padding:.3rem 0; border-bottom:2px solid var(--line);}
.fin-brow.head{font-size:.58rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); border-bottom:2px solid var(--fg); padding-top:0;}
.fin-brow.head span:nth-child(n+2):nth-child(-n+5){text-align:right;}
.fin-brow .num{text-align:right; font-variant-numeric:tabular-nums;}
.fin-brow.over .fin-bname{color:var(--accent);}
.fin-bname{overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.fin-bin{text-align:right; padding:.3rem .4rem; font-size:.76rem;}
.fin-bin::placeholder{color:var(--line);}
.fin-cur{max-width:24rem; margin-bottom:1rem;}
.fin-cur small{text-transform:none; letter-spacing:0; font-size:.65rem;}
.fin-scols{display:grid; grid-template-columns:repeat(3, 1fr); gap:1rem;}
.fin-slist{display:flex; flex-direction:column; gap:.3rem;}
.fin-slabel{font-size:.58rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin-bottom:.1rem; line-height:1.5;}
.fin-srow{display:flex; align-items:center; gap:.3rem;}
.fin-srow .fin-in{padding:.3rem .45rem; font-size:.75rem;}
.fin-used{flex:0 0 1.6rem; text-align:right; font-size:.62rem; color:var(--muted);}
.fin-rates{max-width:24rem;}
.fin-rlab{flex:0 0 auto; font-size:.72rem; color:var(--muted); white-space:nowrap;}
.fin-reassign{border:2px solid var(--accent); padding:.5rem; display:flex; flex-direction:column; gap:.4rem; font-size:.68rem;}
.fin-reassign .fin-btn{padding:.35rem .5rem; font-size:.62rem;}
@media (max-width:900px){
  .fin-tiles{grid-template-columns:repeat(2, 1fr);}
  .fin-grid{grid-template-columns:repeat(2, 1fr);}
  .fin-scols, .fin-two{grid-template-columns:1fr;}
}
@media (max-width:640px){
  .fin-crow{grid-template-columns:6rem 1fr 5.5rem;}
  .fin-cpct{display:none;}
  .fin-search{max-width:none;}
  .fin-mlabel{min-width:0; font-size:.9rem;}
  .fin-grid{grid-template-columns:1fr;}
  .fin-tval{font-size:1.15rem;}
  .fin-brow{grid-template-columns:1fr 6rem 5.5rem; row-gap:.3rem;}
  .fin-brow.head span:nth-child(n+4){display:none;}
  .fin-brow > span:nth-child(4), .fin-brow > span:nth-child(5){display:none;}
  .fin-brow > .fin-pbar, .fin-brow > span:nth-child(6){grid-column:1 / -1;}
  /* transactions become compact 3-line cards:
     description + amount / category + date / method + actions */
  .fin-table:not(.fin-mtable) thead{display:none;}
  .fin-table:not(.fin-mtable), .fin-table:not(.fin-mtable) tbody{display:block; width:100%;}
  .fin-table:not(.fin-mtable) tr{display:grid; grid-template-columns:1fr auto; gap:.2rem .8rem;
    border:2px solid var(--line); margin-bottom:.45rem; padding:.55rem .65rem;}
  .fin-table:not(.fin-mtable) td{display:block; border:none; padding:0; white-space:normal; min-width:0;}
  .fin-table:not(.fin-mtable) tr:hover td{background:transparent;}
  .fin-table:not(.fin-mtable) td[data-l=description]{grid-column:1; grid-row:1 / span 2; font-weight:700;}
  .fin-table:not(.fin-mtable) td.amt{grid-column:2; grid-row:1; text-align:right; white-space:nowrap;}
  .fin-table:not(.fin-mtable) td[data-l=date]{grid-column:2; grid-row:2; text-align:right; color:var(--muted); font-size:.68rem;}
  .fin-table:not(.fin-mtable) td[data-l=category]{grid-column:1; grid-row:3; color:var(--muted); font-size:.68rem;}
  .fin-table:not(.fin-mtable) td[data-l=type]{display:none;}
  .fin-table:not(.fin-mtable) .act{grid-column:2; grid-row:3; width:auto; text-align:right;}
  .fin-mtable{font-size:.68rem;}
}
`;
var style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

window.Finance = { normalize:normalize, fresh:fresh, mount:mount,
  // exposed for tests and future features
  _test:{ parseMoney:parseMoney, convert:convert, monthSum:monthSum, budgetFor:budgetFor, money:money } };
})();
