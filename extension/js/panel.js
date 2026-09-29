/*
 * Render Hare — panel.  v1.0.0
 * by ScriptHare · https://scripthare.com · MIT licence
 *
 * Lists the After Effects Dynamic Link clips in the active sequence (including
 * inside nested sequences) and hands them to Premiere's own
 * Clip > Render and Replace / Restore Unrendered. Exports that still contain
 * live AE comps render them through After Effects frame by frame, which crawls
 * or crashes; rendered clips export like any other media.
 *
 * Scans run on Premiere's main thread (~2 s on a 4000-clip timeline), so they
 * only run on demand: panel open, Rescan, panel focus after the active
 * sequence changed, and once after each Render and Replace finishes.
 */
(function () {
  "use strict";

  var VERSION = "1.0.0";
  var SITE = "https://scripthare.com";
  var PREF_OUTSIDE = "renderhare.includeOutside";
  var cep = window.__adobe_cep__;

  function byId(id) { return document.getElementById(id); }
  var els = {
    seq: byId("seqname"), age: byId("age"), rescan: byId("rescan"), summary: byId("summary"),
    outside: byId("outside"), list: byId("list"), status: byId("status"),
    version: byId("version"), brand: byId("brand")
  };

  // ---- host plumbing -------------------------------------------------------------
  function evalScript(code, cb) {
    try { cep.evalScript(code, function (r) { cb(r); }); }
    catch (e) { cb(JSON.stringify({ ok: false, error: "evalScript failed: " + e })); }
  }
  // RenderHare.<fn>(args) in ExtendScript; cb(envelope).
  function callHost(fn, args, cb) {
    evalScript("RenderHare." + fn + "(" + JSON.stringify(JSON.stringify(args || {})) + ")", function (r) {
      var env;
      try { env = JSON.parse(r); } catch (e) { env = { ok: false, error: "Unexpected reply from Premiere: " + r }; }
      cb(env);
    });
  }
  function extRoot() {
    var p = "";
    try { p = decodeURIComponent(window.location.pathname || ""); } catch (e) { p = window.location.pathname || ""; }
    if (/^\/[A-Za-z]:\//.test(p)) { p = p.substring(1); }
    return p.replace(/\/[^\/]*$/, "");
  }
  // The manifest's ScriptPath loads renderhare.jsx; load it again if another
  // extension's script replaced the engine state, then continue.
  function ensureHost(cb, tries) {
    evalScript("typeof RenderHare", function (r) {
      if (r === "object") { cb(true); return; }
      if ((tries || 0) >= 3) { cb(false); return; }
      evalScript('$.evalFile("' + extRoot() + '/jsx/renderhare.jsx")', function () {
        setTimeout(function () { ensureHost(cb, (tries || 0) + 1); }, 300);
      });
    });
  }

  // ---- theme: follow Premiere's panel colour -------------------------------------
  function applyTheme() {
    try {
      var env = JSON.parse(cep.getHostEnvironment());
      var c = env.appSkinInfo.panelBackgroundColor.color;
      var rgb = [Math.round(c.red), Math.round(c.green), Math.round(c.blue)];
      document.documentElement.style.setProperty("--bg", "rgb(" + rgb.join(",") + ")");
      var lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
      document.documentElement.classList.toggle("light", lum > 0.55);
    } catch (e) {}
  }
  applyTheme();
  try { cep.addEventListener("com.adobe.csxs.events.ThemeColorChanged", applyTheme); } catch (e) {}

  // ---- state + helpers -------------------------------------------------------------
  var state = { data: null, scannedAt: 0, busy: false, working: false, expanded: {}, actions: [], includeOutside: readPref() };
  els.outside.checked = state.includeOutside;
  els.version.textContent = "Render Hare " + VERSION;

  function readPref() {
    try { return window.localStorage.getItem(PREF_OUTSIDE) === "1"; } catch (e) { return false; }
  }
  function writePref(on) {
    try { window.localStorage.setItem(PREF_OUTSIDE, on ? "1" : "0"); } catch (e) {}
  }
  function esc(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function baseName(p) { return String(p || "").split(/[\\\/]/).pop(); }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  // Non-drop-frame timecode, counted at the nominal rate (as Premiere shows 23.976).
  function tc(sec, fps) {
    if (!fps) { return sec.toFixed(2) + "s"; }
    var nominal = Math.round(fps), f = Math.round(sec * fps), s = Math.floor(f / nominal);
    return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60) + ":" + pad(f % nominal);
  }
  function dur(sec) {
    return sec < 60 ? sec.toFixed(1) + "s" : Math.floor(sec / 60) + "m " + Math.round(sec % 60) + "s";
  }
  function setStatus(msg, isErr) {
    els.status.textContent = msg || "";
    els.status.className = "status" + (isErr ? " err" : "");
  }
  function updateAge() {
    if (!state.scannedAt) { els.age.textContent = ""; return; }
    var s = Math.round((Date.now() - state.scannedAt) / 1000);
    els.age.textContent = s < 10 ? "scanned just now" : "scanned " + (s < 60 ? s + "s" : Math.floor(s / 60) + "m") + " ago";
  }
  setInterval(updateAge, 15000);

  function liveClips(d) { return d.clips.filter(function (c) { return !c.rendered; }); }
  function inScope(c) { return state.includeOutside || c.inRange; }
  function register(action) { state.actions.push(action); return state.actions.length - 1; }
  function keysOf(clips) { return clips.map(function (c) { return c.key; }); }
  function totalDur(clips) { return clips.reduce(function (s, c) { return s + (c.endSeconds - c.startSeconds); }, 0); }

  function menuError(r) {
    if (r.error === "accessibility") {
      return "macOS needs permission first: System Settings > Privacy & Security > Accessibility > turn on Adobe Premiere Pro. " +
             "The clips are selected — use the Clip menu for now.";
    }
    return r.error + " The clips are selected — use the Clip menu instead.";
  }

  // ---- scanning --------------------------------------------------------------------
  // Scans the active sequence, or opts.sequenceId (opts.activate also brings it
  // back into the timeline — selecting nested clips switches the timeline away).
  function scan(cb, opts) {
    if (state.busy) { if (cb) { cb(state.data); } return; }
    state.busy = true;
    els.rescan.disabled = true;
    els.rescan.textContent = "Scanning…";
    callHost("find", opts || {}, function (env) {
      state.busy = false;
      els.rescan.disabled = false;
      els.rescan.textContent = "Rescan";
      if (!env.ok) {
        state.data = null;
        els.seq.textContent = "—";
        els.summary.className = "summary";
        els.summary.textContent = /sequence/i.test(env.error) ? "Open a sequence to scan it." : "Scan failed: " + env.error;
        els.list.innerHTML = "";
        if (cb) { cb(null); }
        return;
      }
      state.data = env.data;
      state.scannedAt = Date.now();
      render();
      if (cb) { cb(env.data); }
    });
  }

  function rescanIfStale() {
    if (state.busy || state.working) { return; }
    evalScript("RenderHare.whoami()", function (r) {
      var d = state.data;
      if (!d || r !== d.sequence.id + "|" + d.projectPath) { scan(); }
    });
  }

  // ---- rendering the list ------------------------------------------------------------
  function groupsOf(clips) {
    var map = {}, order = [];
    clips.forEach(function (c) {
      var k = c.sequenceId + "|" + (c.rendered ? "R:" + c.compName : c.projectItemId);
      if (!map[k]) {
        map[k] = { id: k, sequenceId: c.sequenceId, sequenceName: c.sequenceName, compName: c.compName,
                   aepPath: c.aepPath, rendered: c.rendered, clips: [] };
        order.push(map[k]);
      }
      map[k].clips.push(c);
    });
    return order;
  }

  // Top sequence first, then each nested sequence (clips are selected in the
  // sequence that holds them).
  function bySequence(clips, topId) {
    var map = {}, order = [];
    clips.forEach(function (c) {
      if (!map[c.sequenceId]) {
        map[c.sequenceId] = { id: c.sequenceId, name: c.sequenceName, nested: c.sequenceId !== topId, clips: [] };
        order.push(map[c.sequenceId]);
      }
      map[c.sequenceId].clips.push(c);
    });
    order.sort(function (a, b) { return (a.nested ? 1 : 0) - (b.nested ? 1 : 0); });
    return order;
  }

  function groupHtml(g, fps) {
    var act = register({ kind: g.rendered ? "restore" : "render", sequenceId: g.sequenceId, keys: keysOf(g.clips) });
    var open = !!state.expanded[g.id];
    var title = g.rendered ? g.compName : baseName(g.aepPath);
    var sub = (g.rendered ? "rendered" : g.compName) + " · " + plural(g.clips.length, "clip") + " · " + dur(totalDur(g.clips));
    var h = '<div class="grp"><div class="grp-row">' +
      '<button class="toggle" data-toggle="' + esc(g.id) + '" title="Show clips">' + (open ? "▾" : "▸") + "</button>" +
      '<div class="grp-main" data-toggle="' + esc(g.id) + '" title="' + esc(g.aepPath || g.compName) + '">' +
      '<div class="grp-title">' + esc(title) + '</div><div class="grp-sub">' + esc(sub) + "</div></div>" +
      '<button class="btn ' + (g.rendered ? "ghost " : "") + 'small" data-act="' + act + '"' + (state.working ? " disabled" : "") + ">" +
      (g.rendered ? "Restore" : "Render") + "</button></div>";
    if (open) {
      h += '<div class="clips">';
      g.clips.forEach(function (c) {
        var show = register({ kind: "show", sequenceId: c.sequenceId, keys: [c.key], rendered: c.rendered });
        h += '<div class="clip" data-act="' + show + '" title="Select this clip and move the playhead to it">' +
          '<span class="trk">' + esc(c.track) + "</span><span>" + tc(c.startSeconds, fps) + "</span>" +
          "<span>" + dur(c.endSeconds - c.startSeconds) + "</span>" +
          (c.inRange ? "" : '<span class="off">outside In/Out</span>') +
          (c.disabled ? '<span class="off">disabled</span>' : "") + "</div>";
      });
      h += "</div>";
    }
    return h + "</div>";
  }

  function render() {
    var d = state.data;
    if (!d) { return; }
    state.actions = [];
    els.seq.textContent = d.sequence.name;
    updateAge();

    var live = liveClips(d);
    var todo = live.filter(inScope);
    var outsideCount = live.filter(function (c) { return !c.inRange; }).length;
    var rendered = d.clips.filter(function (c) { return c.rendered; });
    var scope = state.includeOutside ? "" : " inside In/Out";

    if (todo.length) {
      els.summary.className = "summary bad";
      els.summary.innerHTML = "<strong>" + plural(todo.length, "live After Effects clip") + "</strong>" + scope +
        ". Exporting renders them through After Effects — slow, and it can crash.";
    } else {
      els.summary.className = "summary good";
      els.summary.innerHTML = "<strong>No live After Effects clips</strong>" + scope + ". Safe to export.";
    }
    if (!state.includeOutside && outsideCount) {
      els.summary.innerHTML += ' <span class="muted">' + outsideCount + " more outside In/Out.</span>";
    }

    var h = "";
    bySequence(todo, d.sequence.id).forEach(function (s) {
      var all = register({ kind: "render", sequenceId: s.id, keys: keysOf(s.clips) });
      h += '<div class="section"><div class="section-head"><span>' +
        (s.nested ? "Inside nested sequence: " + esc(s.name) : "Live comps") + "</span></div>" +
        '<button class="btn wide" data-act="' + all + '"' + (state.working ? " disabled" : "") + ">Render and Replace " +
        (s.clips.length > 1 ? "all " : "") + plural(s.clips.length, "clip") + "</button>";
      groupsOf(s.clips).forEach(function (g) { h += groupHtml(g, d.fps); });
      h += "</div>";
    });

    if (rendered.length) {
      var open = !!state.expanded.__rendered;
      h += '<div class="section"><div class="section-head">' +
        '<button class="toggle" data-toggle="__rendered">' + (open ? "▾" : "▸") + "</button>" +
        '<span data-toggle="__rendered" style="cursor:pointer">Already rendered (' + rendered.length + ")</span></div>";
      if (open) { groupsOf(rendered).forEach(function (g) { h += groupHtml(g, d.fps); }); }
      h += "</div>";
    }
    if (!todo.length && !rendered.length) {
      h += '<div class="empty">No Dynamic Link clips in this sequence.</div>';
    }
    els.list.innerHTML = h;
  }

  // ---- actions -------------------------------------------------------------------------
  function setWorking(on) {
    state.working = on;
    var btns = els.list.querySelectorAll("button[data-act]");
    for (var b = 0; b < btns.length; b++) { btns[b].disabled = on; }
  }

  function selectClips(a, cb) {
    callHost("select", { sequenceId: a.sequenceId, keys: a.keys, rendered: !!(a.kind === "restore" || a.rendered) }, cb);
  }

  // Rescan the sequence the list was showing, returning the timeline to it if
  // the action had to open a nested sequence.
  function rescanTop(a, cb) {
    var topId = state.data.sequence.id;
    scan(cb, { sequenceId: topId, activate: a.sequenceId !== topId });
  }

  function renderAndReplace(a) {
    var before = liveClips(state.data).length;
    setWorking(true);
    setStatus("Selecting " + plural(a.keys.length, "clip") + "…");
    selectClips(a, function (env) {
      if (!env.ok || !env.data.selected) {
        setWorking(false);
        setStatus(env.ok ? "Those clips have changed — rescanning." : "Couldn't select the clips: " + env.error, true);
        scan();
        return;
      }
      setStatus("Render and Replace is open for " + plural(env.data.selected, "clip") +
        " — confirm in Premiere's dialog. This list refreshes when it finishes.");
      window.RenderHareMenu.run("renderAndReplace", 3600, function (r) {
        if (!r.ok) { setWorking(false); setStatus(menuError(r), true); return; }
        rescanTop(a, function (d) {
          setWorking(false);
          var after = d ? liveClips(d).length : before;
          if (!r.dialogSeen) {
            setStatus("Premiere didn't open the dialog. The clips are selected — use Clip > Render and Replace instead.", true);
          } else if (!r.finished) {
            setStatus("Still rendering after an hour — press Rescan when it's done.");
          } else if (after < before) {
            setStatus("Done: " + plural(before - after, "clip") + " replaced with rendered media.");
          } else {
            setStatus("Nothing was replaced (dialog cancelled?).");
          }
        });
      });
    });
  }

  function restoreUnrendered(a) {
    var before = liveClips(state.data).length;
    setWorking(true);
    setStatus("Restoring " + plural(a.keys.length, "clip") + "…");
    selectClips(a, function (env) {
      if (!env.ok || !env.data.selected) {
        setWorking(false);
        setStatus(env.ok ? "Those clips have changed — rescanning." : "Couldn't select the clips: " + env.error, true);
        scan();
        return;
      }
      window.RenderHareMenu.run("restoreUnrendered", 0, function (r) {
        if (!r.ok) { setWorking(false); setStatus(menuError(r), true); return; }
        setTimeout(function () {
          rescanTop(a, function (d) {
            setWorking(false);
            var after = d ? liveClips(d).length : before;
            setStatus(after > before ? "Restored " + plural(after - before, "clip") + " to live After Effects comps."
                                     : "Nothing was restored.");
          });
        }, 1500);
      });
    });
  }

  function showClip(a) {
    selectClips(a, function (env) {
      if (!env.ok) { setStatus("Couldn't select that clip: " + env.error, true); return; }
      if (!env.data.selected) { setStatus("That clip has moved — rescanning."); scan(); }
    });
  }

  els.list.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-toggle], [data-act]");
    if (!t) { return; }
    var tog = t.getAttribute("data-toggle");
    if (tog !== null) { state.expanded[tog] = !state.expanded[tog]; render(); return; }
    var a = state.actions[Number(t.getAttribute("data-act"))];
    if (!a) { return; }
    if (a.kind === "show") { showClip(a); return; }
    if (state.working) { return; }
    if (a.kind === "render") { renderAndReplace(a); } else { restoreUnrendered(a); }
  });
  els.rescan.addEventListener("click", function () { setStatus(""); scan(); });
  els.outside.addEventListener("change", function () {
    state.includeOutside = els.outside.checked;
    writePref(state.includeOutside);
    render();
  });
  els.brand.addEventListener("click", function (ev) {
    ev.preventDefault();
    try { window.cep.util.openURLInDefaultBrowser(SITE); } catch (e) {}
  });
  window.addEventListener("focus", rescanIfStale);

  // ---- boot ------------------------------------------------------------------------------
  ensureHost(function (loaded) {
    if (!loaded) { els.summary.textContent = "Render Hare's script didn't load into Premiere. Try reopening the panel."; return; }
    callHost("info", {}, function (env) {
      if (env.ok && !env.data.supported) {
        els.summary.className = "summary bad";
        els.summary.textContent = "Render Hare needs Premiere Pro 2026 (26.0) or newer — this is " + env.data.premiereVersion + ".";
        return;
      }
      scan();
    });
  });
})();
