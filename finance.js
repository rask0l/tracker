// finance.js: the Finance page type (step 1: transactions + monthly overview).
//
// index.html owns storage, sync, undo and the page shell; this file only knows
// a page's `finance` object. It exposes:
//   Finance.normalize(f)   validate saved data (used when loading/importing)
//   Finance.fresh()        an empty finance object with default categories
//   Finance.mount(ctx)     draw the page into ctx.root; ctx = { root, page, save }
//
// Money is stored as integers in the currency's minor unit (cents for USD,
// riel for KHR), so sums never drift the way decimal floats do.
(function(){
"use strict";

// ---------- data ----------
var CURRENCIES = {
  USD:{ dec:2, name:"US dollar" }, KHR:{ dec:0, name:"Cambodian riel" },
  EUR:{ dec:2, name:"Euro" },      GBP:{ dec:2, name:"British pound" },
  THB:{ dec:2, name:"Thai baht" }, SGD:{ dec:2, name:"Singapore dollar" },
  AUD:{ dec:2, name:"Australian dollar" }, JPY:{ dec:0, name:"Japanese yen" }
};
var DEFAULT_EXPENSE = ["Food","Transportation","Rent","Bills","Shopping","Entertainment","Health","Education","Other"];
var DEFAULT_INCOME = ["Salary","Freelance","Side hustle","Other income"];
var DEFAULT_METHODS = ["Cash","Bank","Card"];
var MAX = 1e13;           // far beyond any real amount, still exact as a JS number
var PER_PAGE = 20;

function rid(){ return "f" + Math.random().toString(36).slice(2, 10); }
function str(v, max){ return String(v == null ? "" : v).slice(0, max); }
function isDate(s){
  if(typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(+s.slice(0,4), +s.slice(5,7) - 1, +s.slice(8,10));
  return d.getMonth() === +s.slice(5,7) - 1 && d.getDate() === +s.slice(8,10);
}
function isAmount(n){ return Number.isInteger(n) && n > 0 && n < MAX; }
function defaultCats(){
  return DEFAULT_EXPENSE.map(function(n){ return { id:rid(), name:n, kind:"expense" }; })
    .concat(DEFAULT_INCOME.map(function(n){ return { id:rid(), name:n, kind:"income" }; }));
}
function fresh(){
  return { currency:"USD", categories:defaultCats(), methods:DEFAULT_METHODS.slice(), txns:[], goals:[], recurring:[] };
}
function normalize(f){
  f = (f && typeof f === "object") ? f : {};
  var out = { currency: CURRENCIES[f.currency] ? f.currency : "USD" };
  var seen = {};
  out.categories = (Array.isArray(f.categories) ? f.categories : []).filter(function(c){
    return c && typeof c.name === "string" && c.name.trim() && (c.kind === "income" || c.kind === "expense");
  }).map(function(c){
    var o = { id:str(c.id || rid(), 40), name:str(c.name.trim(), 40), kind:c.kind };
    if(seen[o.id]) o.id = rid();
    seen[o.id] = 1;
    if(isAmount(c.budget)) o.budget = c.budget;          // used by step 2
    return o;
  });
  if(!out.categories.length) out.categories = defaultCats();
  var ms = {};
  out.methods = (Array.isArray(f.methods) ? f.methods : []).map(function(m){ return str(m, 30).trim(); })
    .filter(function(m){ if(!m || ms[m.toLowerCase()]) return false; ms[m.toLowerCase()] = 1; return true; });
  if(!out.methods.length) out.methods = DEFAULT_METHODS.slice();
  out.txns = (Array.isArray(f.txns) ? f.txns : []).filter(function(t){
    return t && (t.type === "income" || t.type === "expense") && isDate(t.date) && isAmount(t.amount);
  }).map(function(t){
    var o = { id:str(t.id || rid(), 40), date:t.date, type:t.type, amount:t.amount,
              categoryId:str(t.categoryId, 40), method:str(t.method, 30), note:str(t.note, 200) };
    if(t.recurringId) o.recurringId = str(t.recurringId, 40);
    return o;
  });
  if(isAmount(f.monthlyLimit)) out.monthlyLimit = f.monthlyLimit;
  // later steps: kept as they are until those steps validate them
  out.goals = Array.isArray(f.goals) ? f.goals : [];
  out.recurring = Array.isArray(f.recurring) ? f.recurring : [];
  return out;
}

// ---------- money and dates ----------
var fmtCache = {};
function money(f, minor, signed){
  var c = CURRENCIES[f.currency];
  var key = f.currency;
  if(!fmtCache[key]) fmtCache[key] = new Intl.NumberFormat("en-US",
    { style:"currency", currency:f.currency, minimumFractionDigits:c.dec, maximumFractionDigits:c.dec });
  var s = fmtCache[key].format(Math.abs(minor) / Math.pow(10, c.dec));
  if(minor < 0) return "−" + s;
  return signed && minor > 0 ? "+" + s : s;
}
// "1,234.56", "$12", "12.5" -> minor units, rounded half up; NaN if not a number
function parseMoney(s, dec){
  s = String(s).replace(/[\s,]/g, "").replace(/^[^\d.]+/, "");
  if(!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return NaN;
  var parts = s.split("."), whole = parts[0] || "0", frac = parts[1] || "", up = 0;
  if(frac.length > dec){ up = +frac.charAt(dec) >= 5 ? 1 : 0; frac = frac.slice(0, dec); }
  while(frac.length < dec) frac += "0";
  return parseInt(whole + frac, 10) + up;
}
function toInput(f, minor){
  var dec = CURRENCIES[f.currency].dec;
  if(!dec) return String(minor);
  var s = String(minor).padStart(dec + 1, "0");
  return s.slice(0, -dec) + "." + s.slice(-dec);
}
var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function pad(n){ return (n < 10 ? "0" : "") + n; }
function today(){ var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function thisMonth(){ return today().slice(0, 7); }
function addMonths(ym, k){
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + k;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + "-" + pad(m + 1);
}
function monthLabel(ym){ return MONTHS[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4); }
function shortDate(d){ return +d.slice(8, 10) + " " + MON[+d.slice(5, 7) - 1] + (d.slice(0, 4) !== thisMonth().slice(0, 4) ? " " + d.slice(0, 4) : ""); }

// ---------- totals ----------
function totals(f, ym){
  var inc = 0, exp = 0;
  f.txns.forEach(function(t){
    if(ym && t.date.slice(0, 7) !== ym) return;
    if(t.type === "income") inc += t.amount; else exp += t.amount;
  });
  return { inc:inc, exp:exp, net:inc - exp, rate: inc > 0 ? (inc - exp) / inc * 100 : null };
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

// ---------- the page ----------
var uiState = {};     // view state per page id; survives redraws and undo
function mount(ctx){
  var p = ctx.page, f = p.finance, root = ctx.root;
  var u = uiState[p.id] || (uiState[p.id] = { month:thisMonth(), scope:"month", q:"", type:"", cat:"",
    method:"", sort:"date", dir:-1, pg:0, form:null, settings:false });
  var dec = function(){ return CURRENCIES[f.currency].dec; };
  function catById(id){ for(var i = 0; i < f.categories.length; i++) if(f.categories[i].id === id) return f.categories[i]; return null; }
  function catName(id){ var c = catById(id); return c ? c.name : "uncategorized"; }
  function commit(){ ctx.save(); draw(); }

  var tableBox = null;
  function draw(){
    root.innerHTML = "";
    root.appendChild(toolbar());
    if(u.settings) root.appendChild(settings());
    if(u.form) root.appendChild(form());
    root.appendChild(overview());
    root.appendChild(topCats());
    tableBox = h("section", { class:"fin-sec" });
    root.appendChild(tableBox);
    drawTable();
  }

  // ----- month switcher + actions -----
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
        h("button", { type:"button", class:"fin-btn fin-primary", text:"+ expense", onclick:function(){ openForm("expense"); } }),
        h("button", { type:"button", class:"fin-btn fin-ghost" + (u.settings ? " on" : ""), text:"settings",
          onclick:function(){ u.settings = !u.settings; draw(); } })
      ])
    ]);
  }

  // ----- the four tiles, compared with last month -----
  function delta(cur, prev, goodWhenUp, points){
    if(points){
      if(cur == null || prev == null) return null;
      var d = Math.round((cur - prev) * 10) / 10;
      if(!d) return h("span", { class:"fin-delta", text:"same as last month" });
      return h("span", { class:"fin-delta " + ((d > 0) === goodWhenUp ? "good" : "bad"),
        text:(d > 0 ? "▲ " : "▼ ") + Math.abs(d) + " pts vs last month" });
    }
    if(!prev && !cur) return null;
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
  function overview(){
    var t = totals(f, u.month), pv = totals(f, addMonths(u.month, -1)), all = totals(f, null);
    var months = {}; f.txns.forEach(function(x){ months[x.date.slice(0, 7)] = 1; });
    var nMonths = Object.keys(months).length;
    var first = Object.keys(months).sort()[0];
    return h("section", { class:"fin-sec" }, [
      h("div", { class:"fin-tiles" }, [
        tile("income", money(f, t.inc), delta(t.inc, pv.inc, true)),
        tile("expenses", money(f, t.exp), delta(t.exp, pv.exp, false)),
        tile("left this month", money(f, t.net), delta(t.net, pv.net, true), t.net < 0 ? "neg" : ""),
        tile("savings rate", t.rate == null ? "—" : (Math.round(t.rate * 10) / 10) + "%",
          t.rate == null ? h("span", { class:"fin-delta", text:"no income this month" }) : delta(t.rate, pv.rate, true, true),
          t.rate != null && t.rate < 0 ? "neg" : "")
      ]),
      nMonths ? h("p", { class:"fin-overall" }, [
        "saved overall: ", h("b", { class: all.net < 0 ? "neg" : "", text:money(f, all.net) }),
        " since " + monthLabel(first) + " · average " + money(f, Math.round(all.net / nMonths)) + " a month"
      ]) : null
    ]);
  }

  // ----- where this month's money went -----
  function topCats(){
    var by = {}, total = 0;
    f.txns.forEach(function(t){
      if(t.type !== "expense" || t.date.slice(0, 7) !== u.month) return;
      by[t.categoryId] = (by[t.categoryId] || 0) + t.amount; total += t.amount;
    });
    var rows = Object.keys(by).map(function(id){ return { id:id, amt:by[id] }; })
      .sort(function(a, b){ return b.amt - a.amt; });
    if(!rows.length) return h("div");
    var max = rows[0].amt;
    return h("section", { class:"fin-sec" }, [
      h("h3", { class:"fin-h", text:"where it went · " + monthLabel(u.month) }),
      h("div", { class:"fin-cats" }, rows.map(function(r){
        var pct = Math.round(r.amt / total * 100);
        return h("div", { class:"fin-crow" }, [
          h("span", { class:"fin-cname", text:catName(r.id) }),
          h("span", { class:"fin-cbar" }, [ h("i", { style:"width:" + (r.amt / max * 100) + "%" }) ]),
          h("span", { class:"fin-camt", text:money(f, r.amt) }),
          h("span", { class:"fin-cpct", text:pct + "%" })
        ]);
      }))
    ]);
  }

  // ----- add / edit form -----
  function openForm(type, t){
    var inMonth = u.month === thisMonth();
    u.form = t ? { id:t.id, type:t.type, amount:toInput(f, t.amount), date:t.date, cat:t.categoryId, method:t.method, note:t.note }
               : { type:type, amount:"", date: inMonth ? today() : u.month + "-01", cat:"", method:f.methods[0] || "", note:"" };
    draw();
    var a = root.querySelector(".fin-form .fin-amount"); if(a) a.focus();
  }
  function form(){
    var fm = u.form, editing = !!fm.id;
    var cats = f.categories.filter(function(c){ return c.kind === fm.type; });
    if(!fm.cat || !catById(fm.cat) || catById(fm.cat).kind !== fm.type) fm.cat = cats.length ? cats[0].id : "";
    var msg = h("div", { class:"fin-msg" });
    var newCat = h("input", { type:"text", class:"fin-in fin-newcat", placeholder:"new category name", maxlength:"40", hidden:true });
    var newMethod = h("input", { type:"text", class:"fin-in fin-newm", placeholder:"new payment method", maxlength:"30", hidden:true });
    var catSel = h("select", { class:"fin-in", "aria-label":"category" },
      cats.map(function(c){ return h("option", { value:c.id, text:c.name }); })
        .concat([h("option", { value:"__new", text:"+ new category…" })]));
    catSel.value = fm.cat;
    catSel.addEventListener("change", function(){
      newCat.hidden = catSel.value !== "__new"; if(!newCat.hidden) newCat.focus(); else fm.cat = catSel.value;
    });
    var mSel = h("select", { class:"fin-in", "aria-label":"payment method" },
      f.methods.map(function(m){ return h("option", { value:m, text:m }); })
        .concat(fm.method && f.methods.indexOf(fm.method) < 0 ? [h("option", { value:fm.method, text:fm.method })] : [])
        .concat([h("option", { value:"__new", text:"+ new method…" })]));
    mSel.value = fm.method;
    mSel.addEventListener("change", function(){
      newMethod.hidden = mSel.value !== "__new"; if(!newMethod.hidden) newMethod.focus(); else fm.method = mSel.value;
    });
    var amt = h("input", { type:"text", class:"fin-in fin-amount", inputmode:"decimal", placeholder: dec() ? "0.00" : "0",
      value:fm.amount, "aria-label":"amount", oninput:function(){ fm.amount = amt.value; } });
    var date = h("input", { type:"date", class:"fin-in", value:fm.date, "aria-label":"date",
      onchange:function(){ fm.date = date.value; } });
    var note = h("input", { type:"text", class:"fin-in fin-note", maxlength:"200", placeholder:"description (optional)",
      value:fm.note, "aria-label":"description", oninput:function(){ fm.note = note.value; } });
    function submit(){
      var minor = parseMoney(amt.value, dec());
      if(!(minor > 0)){ msg.textContent = "enter an amount above zero"; amt.focus(); return; }
      if(minor >= MAX){ msg.textContent = "that amount is too large"; amt.focus(); return; }
      if(!isDate(date.value)){ msg.textContent = "pick a date"; date.focus(); return; }
      var catId = catSel.value;
      if(catId === "__new"){
        var nm = newCat.value.trim();
        if(!nm){ msg.textContent = "name the new category"; newCat.focus(); return; }
        var ex = f.categories.filter(function(c){ return c.kind === fm.type && c.name.toLowerCase() === nm.toLowerCase(); })[0];
        if(ex) catId = ex.id;
        else{ var c = { id:rid(), name:nm.slice(0, 40), kind:fm.type }; f.categories.push(c); catId = c.id; }
      }
      var method = mSel.value;
      if(method === "__new"){
        method = newMethod.value.trim().slice(0, 30);
        if(!method){ msg.textContent = "name the new payment method"; newMethod.focus(); return; }
        if(!f.methods.some(function(m){ return m.toLowerCase() === method.toLowerCase(); })) f.methods.push(method);
      }
      var rec = { date:date.value, type:fm.type, amount:minor, categoryId:catId, method:method, note:note.value.trim().slice(0, 200) };
      if(editing){
        var t = f.txns.filter(function(x){ return x.id === fm.id; })[0];
        if(t) Object.keys(rec).forEach(function(k){ t[k] = rec[k]; });
      }else{ rec.id = rid(); f.txns.push(rec); }
      u.form = null;
      u.month = rec.date.slice(0, 7);         // show the month it landed in
      commit();
    }
    [amt, note, newCat, newMethod].forEach(function(i){
      i.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); submit(); } if(e.key === "Escape"){ u.form = null; draw(); } });
    });
    var typeBtn = function(t){
      return h("button", { type:"button", class:"fin-tog" + (fm.type === t ? " on" : ""), text:t,
        onclick:function(){ fm.type = t; fm.cat = ""; draw(); root.querySelector(".fin-amount").focus(); } });
    };
    return h("section", { class:"fin-sec fin-form" }, [
      h("div", { class:"fin-fhead" }, [
        h("span", { class:"fin-h", text: editing ? "edit transaction" : "new transaction" }),
        h("span", { class:"fin-toggle" }, [ typeBtn("expense"), typeBtn("income") ])
      ]),
      h("div", { class:"fin-grid" }, [
        h("label", null, ["amount", amt]),
        h("label", null, ["date", date]),
        h("label", null, ["category", catSel, newCat]),
        h("label", null, [fm.type === "income" ? "received via" : "paid with", mSel, newMethod]),
        h("label", { class:"wide" }, ["description", note])
      ]),
      msg,
      h("div", { class:"fin-frow" }, [
        h("button", { type:"button", class:"fin-btn fin-primary", text: editing ? "save changes" : "add " + fm.type, onclick:submit }),
        h("button", { type:"button", class:"fin-btn fin-ghost", text:"cancel", onclick:function(){ u.form = null; draw(); } })
      ])
    ]);
  }

  // ----- the transaction table -----
  function drawTable(){
    var box = tableBox;
    box.innerHTML = "";
    var q = u.q.trim().toLowerCase();
    var rows = f.txns.filter(function(t){
      if(u.scope === "month" && t.date.slice(0, 7) !== u.month) return false;
      if(u.type && t.type !== u.type) return false;
      if(u.cat && t.categoryId !== u.cat) return false;
      if(u.method && t.method !== u.method) return false;
      if(q){
        var hay = (t.note + " " + catName(t.categoryId) + " " + t.method + " " + t.type + " " + t.date + " " +
                   money(f, t.amount) + " " + toInput(f, t.amount)).toLowerCase();
        if(hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = {
      date:function(t){ return t.date; }, note:function(t){ return t.note.toLowerCase(); },
      category:function(t){ return catName(t.categoryId).toLowerCase(); }, type:function(t){ return t.type; },
      amount:function(t){ return t.type === "income" ? t.amount : -t.amount; }, method:function(t){ return t.method.toLowerCase(); }
    }[u.sort];
    rows.sort(function(a, b){
      var x = key(a), y = key(b);
      if(x < y) return -u.dir; if(x > y) return u.dir;
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;      // newest first on ties
    });
    var inSum = 0, outSum = 0;
    rows.forEach(function(t){ if(t.type === "income") inSum += t.amount; else outSum += t.amount; });
    var pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    if(u.pg >= pages) u.pg = pages - 1;
    var shown = rows.slice(u.pg * PER_PAGE, (u.pg + 1) * PER_PAGE);

    var search = h("input", { type:"search", class:"fin-in fin-search", placeholder:"search description, category, amount…",
      value:u.q, "aria-label":"search transactions",
      oninput:function(){ u.q = search.value; u.pg = 0; drawTable(); var s = box.querySelector(".fin-search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
    function sel(label, val, opts, set){
      var s = h("select", { class:"fin-in fin-filter", "aria-label":label }, opts.map(function(o){ return h("option", { value:o[0], text:o[1] }); }));
      s.value = val; s.addEventListener("change", function(){ set(s.value); u.pg = 0; drawTable(); });
      return s;
    }
    var cats = f.categories.slice().sort(function(a, b){ return a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "expense" ? -1 : 1; });
    box.appendChild(h("div", { class:"fin-thead" }, [
      h("h3", { class:"fin-h", text:"transactions" }),
      h("div", { class:"fin-filters" }, [
        search,
        sel("period", u.scope, [["month", monthLabel(u.month)], ["all", "all time"]], function(v){ u.scope = v; }),
        sel("type", u.type, [["", "all types"], ["income", "income"], ["expense", "expenses"]], function(v){ u.type = v; }),
        sel("category", u.cat, [["", "all categories"]].concat(cats.map(function(c){ return [c.id, c.name]; })), function(v){ u.cat = v; }),
        sel("payment method", u.method, [["", "all methods"]].concat(f.methods.map(function(m){ return [m, m]; })), function(v){ u.method = v; })
      ])
    ]));
    if(!f.txns.length){
      box.appendChild(h("div", { class:"fin-empty" }, [
        h("b", { text:"no transactions yet" }),
        h("span", { text:"add your first income or expense with the buttons above. amounts are in " + CURRENCIES[f.currency].name + "s (change it in settings)." })
      ]));
      return;
    }
    if(!rows.length){
      box.appendChild(h("div", { class:"fin-empty" }, [ h("b", { text:"nothing matches" }),
        h("span", { text: u.scope === "month" ? "no transactions in " + monthLabel(u.month) + " with these filters." : "try a different search or filter." }) ]));
      return;
    }
    function th(k, label, cls){
      return h("th", { class:(cls || "") + (u.sort === k ? " sorted" : ""), scope:"col" }, [
        h("button", { type:"button", text:label + (u.sort === k ? (u.dir > 0 ? " ↑" : " ↓") : ""),
          onclick:function(){ if(u.sort === k) u.dir = -u.dir; else { u.sort = k; u.dir = (k === "date" || k === "amount") ? -1 : 1; } drawTable(); } })
      ]);
    }
    var table = h("table", { class:"fin-table" }, [
      h("thead", null, [ h("tr", null, [ th("date", "date"), th("note", "description"), th("category", "category"),
        th("type", "type"), th("amount", "amount", "num"), th("method", "method"), h("th", { class:"act", text:"" }) ]) ]),
      h("tbody", null, shown.map(function(t){
        var del = armed(h("button", { type:"button", class:"fin-act", "aria-label":"delete", text:"×" }), "sure?", function(){
          f.txns = f.txns.filter(function(x){ return x.id !== t.id; }); commit();
        });
        return h("tr", { class:t.type }, [
          h("td", { "data-l":"date", title:t.date, text:shortDate(t.date) }),
          h("td", { "data-l":"description", class:"desc", text:t.note || "—" }),
          h("td", { "data-l":"category", text:catName(t.categoryId) }),
          h("td", { "data-l":"type", text:t.type }),
          h("td", { "data-l":"amount", class:"num amt", text:money(f, t.type === "income" ? t.amount : -t.amount, true) }),
          h("td", { "data-l":"method", text:t.method || "—" }),
          h("td", { class:"act" }, [
            h("button", { type:"button", class:"fin-act", "aria-label":"edit", text:"✎",
              onclick:function(){ openForm(t.type, t); root.scrollIntoView({ block:"start" }); } }),
            del ])
        ]);
      }))
    ]);
    box.appendChild(h("div", { class:"fin-twrap" }, [table]));
    box.appendChild(h("div", { class:"fin-tfoot" }, [
      h("span", null, [ rows.length + (rows.length === 1 ? " transaction" : " transactions") + " · in ",
        h("b", { text:money(f, inSum) }), " · out ", h("b", { text:money(f, outSum) }),
        " · net ", h("b", { class: inSum - outSum < 0 ? "neg" : "", text:money(f, inSum - outSum) }) ]),
      pages > 1 ? h("span", { class:"fin-pager" }, [
        h("button", { type:"button", class:"fin-nav", text:"‹", disabled:u.pg === 0, "aria-label":"previous page",
          onclick:function(){ u.pg--; drawTable(); } }),
        h("span", { text:(u.pg * PER_PAGE + 1) + "–" + Math.min(rows.length, (u.pg + 1) * PER_PAGE) + " of " + rows.length }),
        h("button", { type:"button", class:"fin-nav", text:"›", disabled:u.pg >= pages - 1, "aria-label":"next page",
          onclick:function(){ u.pg++; drawTable(); } })
      ]) : null
    ]));
  }

  // ----- settings: currency, categories, payment methods -----
  function settings(){
    var locked = f.txns.length > 0;
    var cur = h("select", { class:"fin-in", disabled:locked, "aria-label":"currency" },
      Object.keys(CURRENCIES).map(function(k){ return h("option", { value:k, text:k + " · " + CURRENCIES[k].name }); }));
    cur.value = f.currency;
    cur.addEventListener("change", function(){ f.currency = cur.value; commit(); });
    function catList(kind){
      var list = f.categories.filter(function(c){ return c.kind === kind; });
      var add = h("input", { type:"text", class:"fin-in", maxlength:"40", placeholder:"+ add a category" });
      add.addEventListener("keydown", function(e){
        if(e.key !== "Enter") return;
        var nm = add.value.trim();
        if(!nm || list.some(function(c){ return c.name.toLowerCase() === nm.toLowerCase(); })) return;
        f.categories.push({ id:rid(), name:nm, kind:kind }); commit();
      });
      return h("div", { class:"fin-slist" }, [ h("div", { class:"fin-slabel", text:kind === "expense" ? "expense categories" : "income sources" }) ]
        .concat(list.map(function(c){
          var used = f.txns.filter(function(t){ return t.categoryId === c.id; }).length;
          var name = h("input", { type:"text", class:"fin-in", maxlength:"40", value:c.name, "aria-label":"category name" });
          name.addEventListener("change", function(){ var v = name.value.trim(); if(v){ c.name = v; commit(); } else name.value = c.name; });
          var del = armed(h("button", { type:"button", class:"fin-act", text:"×", "aria-label":"delete category",
            title: used ? used + " transaction(s) move to Other" : "delete" }), "sure?", function(){
            // its transactions move to "Other" (or "Other income") so nothing is lost
            var fallback = f.categories.filter(function(x){ return x.kind === kind && x.id !== c.id && /^other/i.test(x.name); })[0];
            if(!fallback && used){ fallback = { id:rid(), name:kind === "expense" ? "Other" : "Other income", kind:kind }; f.categories.push(fallback); }
            f.txns.forEach(function(t){ if(t.categoryId === c.id) t.categoryId = fallback.id; });
            f.categories = f.categories.filter(function(x){ return x !== c; });
            if(u.cat === c.id) u.cat = "";
            commit();
          });
          return h("div", { class:"fin-srow" }, [ name, h("span", { class:"fin-used", text: used ? String(used) : "" }), del ]);
        })).concat([add]));
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
          f.txns.forEach(function(t){ if(t.method === m) t.method = v; });      // renaming follows through
          f.methods[i] = v; if(u.method === m) u.method = v; commit();
        });
        var del = armed(h("button", { type:"button", class:"fin-act", text:"×", "aria-label":"delete method" }), "sure?", function(){
          f.methods.splice(i, 1); if(u.method === m) u.method = ""; commit();   // old transactions keep the name
        });
        return h("div", { class:"fin-srow" }, [ name, h("span", { class:"fin-used" }), del ]);
      })).concat([addM]));
    return h("section", { class:"fin-sec fin-settings" }, [
      h("div", { class:"fin-fhead" }, [ h("span", { class:"fin-h", text:"settings" }),
        h("button", { type:"button", class:"fin-link", text:"close", onclick:function(){ u.settings = false; draw(); } }) ]),
      h("label", { class:"fin-cur" }, [ "currency", cur,
        h("small", { text: locked ? "locked once you have transactions: changing it would relabel amounts without converting them"
                                  : "pick this before adding transactions" }) ]),
      h("div", { class:"fin-scols" }, [ catList("expense"), catList("income"), methods ])
    ]);
  }

  draw();
}

// ---------- styles (same tokens as index.html) ----------
var css = `
.fin{margin-top:.5rem;}
.fin-sec{margin-bottom:1.6rem;}
.fin-bar{display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:1.4rem;}
.fin-month{display:flex; align-items:center; gap:.6rem;}
.fin-mlabel{font-size:1.05rem; font-weight:700; letter-spacing:.1em; text-transform:uppercase; min-width:11.5rem; text-align:center;}
.fin-nav{background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; width:2rem; height:2rem; cursor:pointer; line-height:1;}
.fin-nav:hover:not(:disabled){border-color:var(--fg);}
.fin-nav:disabled{opacity:.3; cursor:default;}
.fin-link{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.66rem; letter-spacing:.12em; text-transform:uppercase; cursor:pointer; padding:0;}
.fin-link:hover{color:var(--accent);}
.fin-actions{display:flex; gap:.4rem; flex-wrap:wrap;}
.fin-btn{background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.7rem; letter-spacing:.1em; text-transform:uppercase; padding:.5rem .8rem; cursor:pointer;}
.fin-btn:hover{border-color:var(--fg);}
.fin-btn.fin-primary{border-color:var(--accent); color:var(--accent);}
.fin-btn.fin-primary:hover{background:var(--accent); color:var(--accent-ink);}
.fin-btn.fin-ghost{color:var(--muted);}
.fin-btn.fin-ghost.on{border-color:var(--fg); color:var(--fg);}
.fin-tiles{display:grid; grid-template-columns:repeat(4, 1fr); gap:.6rem;}
.fin-tile{border:2px solid var(--line); padding:.8rem .9rem .75rem; min-width:0;}
.fin-tlabel{font-size:.6rem; letter-spacing:.14em; text-transform:uppercase; color:var(--muted);}
.fin-tval{font-size:1.45rem; font-weight:700; margin:.3rem 0 .25rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-variant-numeric:tabular-nums;}
.fin-tile.neg .fin-tval{color:var(--accent);}
.fin-delta{display:block; font-size:.6rem; letter-spacing:.06em; color:var(--muted);}
.fin-delta.good{color:var(--fg);}
.fin-delta.bad{color:var(--accent);}
.fin-overall{margin:.7rem 0 0; font-size:.72rem; color:var(--muted); letter-spacing:.04em;}
.fin-overall b{color:var(--fg);}
b.neg, .fin-overall b.neg{color:var(--accent);}
.fin-h{display:block; margin:0 0 .6rem; font-size:.66rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted);}
.fin-cats{display:flex; flex-direction:column; gap:.35rem;}
.fin-crow{display:grid; grid-template-columns:8.5rem 1fr 6.5rem 2.6rem; align-items:center; gap:.7rem; font-size:.75rem;}
.fin-cname{overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.fin-cbar{height:10px; border:2px solid var(--line); position:relative;}
.fin-cbar i{position:absolute; left:0; top:0; bottom:0; background:var(--accent);}
.fin-camt{text-align:right; font-variant-numeric:tabular-nums;}
.fin-cpct{text-align:right; color:var(--muted);}
.fin-form, .fin-settings{border:2px solid var(--fg); padding:1rem; box-shadow:6px 6px 0 var(--line);}
.fin-fhead{display:flex; justify-content:space-between; align-items:center; margin-bottom:.8rem;}
.fin-fhead .fin-h{margin:0;}
.fin-toggle{display:flex;}
.fin-tog{background:transparent; border:2px solid var(--line); color:var(--muted); font:inherit; font-size:.66rem; letter-spacing:.12em; text-transform:uppercase; padding:.35rem .7rem; cursor:pointer;}
.fin-tog + .fin-tog{border-left:none;}
.fin-tog.on{border-color:var(--accent); background:var(--accent); color:var(--accent-ink);}
.fin-grid{display:grid; grid-template-columns:repeat(4, 1fr); gap:.6rem;}
.fin-grid label, .fin-cur{display:flex; flex-direction:column; gap:.3rem; font-size:.58rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); min-width:0;}
.fin-grid label.wide{grid-column:1 / -1;}
.fin-in{width:100%; background:var(--bg); border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.8rem; padding:.45rem .5rem; outline:none; border-radius:0; color-scheme:dark; letter-spacing:0; text-transform:none;}
.fin-in:focus{border-color:var(--accent);}
.fin-in:disabled{color:var(--muted);}
.fin-amount{font-size:1rem; font-weight:700; font-variant-numeric:tabular-nums;}
select.fin-in{cursor:pointer;}
.fin-msg{min-height:1.1em; margin:.6rem 0 .2rem; font-size:.7rem; color:var(--accent);}
.fin-frow{display:flex; gap:.4rem;}
.fin-thead{display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; flex-wrap:wrap; margin-bottom:.6rem;}
.fin-thead .fin-h{margin:0;}
.fin-filters{display:flex; gap:.4rem; flex-wrap:wrap; flex:1 1 auto; justify-content:flex-end;}
.fin-search{flex:1 1 14rem; max-width:20rem;}
.fin-filter{width:auto; font-size:.72rem; padding:.4rem .4rem;}
.fin-twrap{overflow-x:auto;}
.fin-table{width:100%; border-collapse:collapse; font-size:.76rem;}
.fin-table th{text-align:left; border-bottom:2px solid var(--fg); padding:0;}
.fin-table th button{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.6rem; letter-spacing:.12em; text-transform:uppercase; padding:.45rem .5rem; cursor:pointer; width:100%; text-align:inherit;}
.fin-table th.sorted button, .fin-table th button:hover{color:var(--fg);}
.fin-table td{border-bottom:2px solid var(--line); padding:.5rem; vertical-align:middle; white-space:nowrap;}
.fin-table td.desc{white-space:normal; min-width:10rem; max-width:22rem;}
.fin-table .num{text-align:right; font-variant-numeric:tabular-nums;}
.fin-table tr.expense .amt{color:var(--accent);}
.fin-table tr.income .amt{color:var(--fg); font-weight:700;}
.fin-table tr:hover td{background:#141414;}
.fin-table .act{width:4.5rem; text-align:right; white-space:nowrap;}
.fin-act{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.85rem; cursor:pointer; padding:.1rem .3rem;}
.fin-act:hover{color:var(--fg);}
.fin-act.armed{color:var(--accent); font-size:.6rem; letter-spacing:.08em; text-transform:uppercase;}
.fin-tfoot{display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-top:.7rem; font-size:.68rem; color:var(--muted); letter-spacing:.04em;}
.fin-tfoot b{color:var(--fg);}
.fin-pager{display:flex; align-items:center; gap:.5rem;}
.fin-empty{border:2px dashed var(--line); padding:1.4rem; display:flex; flex-direction:column; gap:.35rem; font-size:.75rem; color:var(--muted);}
.fin-empty b{color:var(--fg); font-size:.8rem; letter-spacing:.08em; text-transform:uppercase;}
.fin-cur{max-width:22rem; margin-bottom:1rem;}
.fin-cur small{text-transform:none; letter-spacing:0; font-size:.65rem;}
.fin-scols{display:grid; grid-template-columns:repeat(3, 1fr); gap:1rem;}
.fin-slist{display:flex; flex-direction:column; gap:.3rem;}
.fin-slabel{font-size:.58rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin-bottom:.1rem;}
.fin-srow{display:flex; align-items:center; gap:.3rem;}
.fin-srow .fin-in{padding:.3rem .45rem; font-size:.75rem;}
.fin-used{flex:0 0 1.6rem; text-align:right; font-size:.62rem; color:var(--muted);}
@media (max-width:900px){
  .fin-tiles{grid-template-columns:repeat(2, 1fr);}
  .fin-grid{grid-template-columns:repeat(2, 1fr);}
  .fin-scols{grid-template-columns:1fr;}
}
@media (max-width:640px){
  .fin-crow{grid-template-columns:6rem 1fr 5.5rem;}
  .fin-cpct{display:none;}
  .fin-search{max-width:none;}
  /* on phones each transaction is a compact 3-line card:
     description + amount / category + date / method + actions */
  .fin-table thead{display:none;}
  .fin-table, .fin-table tbody{display:block; width:100%;}
  .fin-table tr{display:grid; grid-template-columns:1fr auto; gap:.2rem .8rem;
    border:2px solid var(--line); margin-bottom:.45rem; padding:.55rem .65rem;}
  .fin-table td{display:block; border:none; padding:0; white-space:normal; min-width:0; max-width:none;}
  .fin-table tr:hover td{background:transparent;}
  .fin-table td[data-l=description]{grid-column:1; grid-row:1; font-weight:700; min-width:0;}
  .fin-table td.amt{grid-column:2; grid-row:1; text-align:right; white-space:nowrap;}
  .fin-table td[data-l=category]{grid-column:1; grid-row:2; color:var(--muted); font-size:.68rem;}
  .fin-table td[data-l=date]{grid-column:2; grid-row:2; text-align:right; color:var(--muted); font-size:.68rem;}
  .fin-table td[data-l=method]{grid-column:1; grid-row:3; color:var(--muted); font-size:.68rem;}
  .fin-table td[data-l=type]{display:none;}
  .fin-table .act{grid-column:2; grid-row:3; width:auto; text-align:right;}
}
`;
var style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

window.Finance = { normalize:normalize, fresh:fresh, mount:mount, parseMoney:parseMoney, totals:totals };
})();
