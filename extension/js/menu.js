/*
 * Render Hare — runs Premiere's own Clip > Render and Replace / Restore
 * Unrendered menu commands.  v1.0.0
 *
 * Premiere's scripting API can't swap a Dynamic Link clip's media itself
 * (canChangeMediaPath() / canProxy() are false for them), so after the clips
 * are selected the panel triggers the real menu command:
 *   Windows: tools/premiere-menu.ps1 posts WM_COMMAND to Premiere's native menu.
 *   macOS (beta): tools/premiere-menu-mac.applescript clicks it via System Events.
 * Both find the item by its label in every language Premiere ships
 * (locales/menu-strings.json).
 *
 * window.RenderHareMenu.run(command, waitSeconds, cb)
 *   command: "renderAndReplace" | "restoreUnrendered"
 *   cb({ ok, dialogSeen, finished } | { ok: false, error })
 *   error "accessibility" = macOS hasn't allowed GUI scripting yet.
 */
(function () {
  "use strict";

  var childProcess, path, fs;
  try {
    childProcess = require("child_process");
    path = require("path");
    fs = require("fs");
  } catch (e) {
    window.RenderHareMenu = {
      run: function (command, waitSeconds, cb) { cb({ ok: false, error: "Node.js isn't available in this panel." }); }
    };
    return;
  }

  // This extension's folder, from the panel URL ("file:///C:/..." or "file:///Users/...").
  function extRoot() {
    var p = "";
    try { p = decodeURIComponent(window.location.pathname || ""); } catch (e) { p = window.location.pathname || ""; }
    if (/^\/[A-Za-z]:\//.test(p)) { p = p.substring(1); }
    return path.dirname(p);
  }

  // Labels for a command in every language, plus the "…" spelling macOS may use.
  function labelsFor(command) {
    var table = JSON.parse(fs.readFileSync(path.join(extRoot(), "locales", "menu-strings.json"), "utf8"));
    var out = [];
    var byLocale = table[command] || {};
    Object.keys(byLocale).forEach(function (loc) {
      var s = byLocale[loc];
      if (!s) { return; }
      [s, s.replace(/\.\.\.$/, "\u2026"), s.replace(/(\.\.\.|\u2026)$/, "")].forEach(function (v) {
        if (out.indexOf(v) < 0) { out.push(v); }
      });
    });
    return out;
  }

  function lastJsonLine(stdout) {
    var lines = String(stdout || "").trim().split(/\r?\n/);
    return JSON.parse(lines[lines.length - 1]);
  }

  function run(command, waitSeconds, cb) {
    var wait = Math.max(0, Math.min(Number(waitSeconds) || 0, 7200));
    var opts = { windowsHide: true, timeout: (wait + 30) * 1000 };
    var root = extRoot();
    var file, args;

    if (process.platform === "win32") {
      file = "powershell.exe";
      args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "tools", "premiere-menu.ps1"),
              "-Command", command, "-WaitSeconds", String(wait)];
      if (process.ppid) { args.push("-ProcessId", String(process.ppid)); }
    } else if (process.platform === "darwin") {
      var labels;
      try { labels = labelsFor(command); }
      catch (e) { cb({ ok: false, error: "Couldn't read menu labels: " + e.message }); return; }
      file = "/usr/bin/osascript";
      args = [path.join(root, "tools", "premiere-menu-mac.applescript"), String(wait)].concat(labels);
    } else {
      cb({ ok: false, error: "Unsupported platform: " + process.platform });
      return;
    }

    childProcess.execFile(file, args, opts, function (err, stdout) {
      var env;
      try { env = lastJsonLine(stdout); }
      catch (e) { env = { ok: false, error: err ? String(err.message || err) : "The menu helper didn't answer." }; }
      cb(env);
    });
  }

  window.RenderHareMenu = { run: run };
})();
