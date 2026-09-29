/*
 * Render Hare — ExtendScript side.  v1.0.0
 * by ScriptHare · https://scripthare.com · MIT licence
 *
 * Finds After Effects Dynamic Link clips in a Premiere sequence (including
 * inside nested sequences) and selects them, so the panel can run Premiere's
 * own Clip > Render and Replace / Restore Unrendered on them.
 *
 * Everything lives on one global object, RenderHare, because every extension
 * shares Premiere's single ExtendScript engine. Each public function takes a
 * JSON string and returns a JSON envelope: { ok: true, data } | { ok: false, error }.
 *
 * Premiere's DOM is slow on big projects (~0.3 ms per property read; a feature
 * edit can hold 1000+ sequences and 4000 clips on one timeline), so the code
 * reads each project item's media path once, reads clip times only for clips
 * that matter, and never walks every sequence unless it has to.
 */
#include "json2.jsx"

var RenderHare = (function () {
    var VERSION = "1.0.0";
    var TICKS_PER_SECOND = 254016000000;

    function ok(data) { return JSON.stringify({ ok: true, data: (data === undefined ? null : data) }); }
    function err(e) { return JSON.stringify({ ok: false, error: String(e) + (e && e.line ? " (line " + e.line + ")" : "") }); }
    function parseArgs(json) {
        if (!json) { return {}; }
        try { return JSON.parse(json); } catch (e) { return {}; }
    }

    // Sequence lookup by id. The active sequence is the common case; otherwise
    // remember where an id was found last time (sequences rarely move).
    var seqIndexCache = {};
    function sequenceById(id) {
        var active = app.project.activeSequence;
        if (!id) { return active; }
        if (active && String(active.sequenceID) === String(id)) { return active; }
        var seqs = app.project.sequences;
        var hint = seqIndexCache[id];
        if (hint !== undefined && hint < seqs.numSequences && String(seqs[hint].sequenceID) === String(id)) {
            return seqs[hint];
        }
        for (var i = 0, n = seqs.numSequences; i < n; i++) {
            if (String(seqs[i].sequenceID) === String(id)) { seqIndexCache[id] = i; return seqs[i]; }
        }
        return null;
    }

    function openInTimeline(seq) {
        try { app.project.openSequence(seq.sequenceID); } catch (e1) {}
        try { app.project.activeSequence = seq; } catch (e2) {}
    }

    // A Dynamic Link clip's media path is the .aep; its project-item name is
    // "<comp name>/<project file>.aep".
    function dlInfo(pi, mp) {
        if (!/\.aep$/i.test(mp)) { return null; }
        var name = String(pi.name), slash = name.lastIndexOf("/");
        return { compName: (slash > 0 ? name.substring(0, slash) : name), aepPath: mp };
    }

    // A clip already swapped by Render and Replace points at a file Premiere
    // names "<comp><project>.aep_Rendered[_NNN].<ext>".
    function renderedInfo(mp) {
        var m = /([^\\\/]*)\.aep_Rendered(_\d+)?\.[A-Za-z0-9]+$/.exec(mp);
        return m ? { compName: m[1], aepPath: null } : null;
    }

    // fn(projectItem) -> the Sequence behind a nested-sequence item. The name
    // index is built on first use (a sequence and its project item share a
    // name) and candidates are confirmed by nodeId.
    function nestedSeqResolver() {
        var byName = null;
        return function (pi) {
            if (!byName) {
                byName = {};
                var seqs = app.project.sequences;
                for (var s = 0, ns = seqs.numSequences; s < ns; s++) {
                    var sq = seqs[s], nm = String(sq.name);
                    (byName[nm] = byName[nm] || []).push(sq);
                }
            }
            var cands = byName[String(pi.name)] || [], id = String(pi.nodeId);
            for (var i = 0; i < cands.length; i++) {
                try { if (String(cands[i].projectItem.nodeId) === id) { return cands[i]; } } catch (e) {}
            }
            return null;
        };
    }

    // fn(projectItem) -> { dl, rendered, nested }, memoized by nodeId.
    function classifier(resolveNested) {
        var cache = {}, seqFor = resolveNested ? nestedSeqResolver() : null;
        return function (pi) {
            var id = String(pi.nodeId);
            if (cache.hasOwnProperty(id)) { return cache[id]; }
            var mp = "", r = { dl: null, rendered: false, nested: null };
            try { mp = String(pi.getMediaPath()); } catch (e) {}
            r.dl = dlInfo(pi, mp);
            if (!r.dl) { r.dl = renderedInfo(mp); r.rendered = !!r.dl; }
            if (seqFor && !r.dl && !mp) {
                try { if (pi.isSequence()) { r.nested = seqFor(pi); } } catch (e2) {}
            }
            cache[id] = r;
            return r;
        };
    }

    // visit(clip, info) once per Dynamic Link clip on the video tracks of seq,
    // recursing into nested sequences (times reported on the TOP sequence).
    // info.sequenceId is the sequence that physically holds the clip.
    function walk(seq, visit, includeRendered) {
        var seen = {}, classify = classifier(true);
        function scan(sq, offset, winStart, winEnd, path, depth) {
            var tracks = sq.videoTracks;
            for (var t = 0, nt = tracks.numTracks; t < nt; t++) {
                var clips = tracks[t].clips;
                for (var c = 0, nc = clips.numItems; c < nc; c++) {
                    var clip = clips[c];
                    var pi = clip.projectItem;
                    if (!pi) { continue; }
                    var cls = classify(pi);
                    if (!cls.nested && (!cls.dl || (cls.rendered && !includeRendered))) { continue; }
                    var st = clip.start.seconds + offset, en = clip.end.seconds + offset;
                    if (en <= winStart || st >= winEnd) { continue; }
                    if (cls.nested) {
                        if (depth < 4) {
                            scan(cls.nested, st - clip.inPoint.seconds, Math.max(st, winStart), Math.min(en, winEnd),
                                 path + " > " + clip.name, depth + 1);
                        }
                        continue;
                    }
                    var key = "V|" + t + "|" + clip.start.ticks;
                    if (seen[sq.sequenceID + "#" + key]) { continue; }
                    seen[sq.sequenceID + "#" + key] = true;
                    visit(clip, {
                        key: key, sequenceId: String(sq.sequenceID), sequenceName: sq.name, path: path,
                        track: "V" + (t + 1), rendered: cls.rendered,
                        name: clip.name, compName: cls.dl.compName, aepPath: cls.dl.aepPath,
                        projectItemId: String(pi.nodeId),
                        startSeconds: Math.max(st, winStart), endSeconds: Math.min(en, winEnd),
                        disabled: !!clip.disabled
                    });
                }
            }
        }
        scan(seq, 0, 0, 1e9, seq.name, 0);
    }

    // The sequence In/Out in seconds; unset In = 0, unset Out = sequence end.
    function inOut(seq) {
        var endSec = Number(seq.end) / TICKS_PER_SECOND, a = 0, b = endSec;
        try { a = seq.getInPointAsTime().seconds; } catch (e) {}
        try { b = seq.getOutPointAsTime().seconds; } catch (e2) {}
        if (!(a > 0)) { a = 0; }
        if (!(b > a) || b > endSec) { b = endSec; }
        return { inSeconds: a, outSeconds: b };
    }

    // ---- public ----------------------------------------------------------------

    // { version, premiereVersion, supported } — the panel refuses to run below 26.
    function info() {
        try {
            var v = String(app.version), major = parseInt(v, 10);
            return ok({ version: VERSION, premiereVersion: v, supported: major >= 26 });
        } catch (e) { return err(e); }
    }

    // args { sequenceId?, activate?, includeRendered? = true }
    // -> { sequence, projectPath, fps, inSeconds, outSeconds, clips[] }
    function find(json) {
        try {
            var a = parseArgs(json);
            var seq = sequenceById(a.sequenceId);
            if (!seq) { return err(a.sequenceId ? "Sequence not found." : "No sequence is open."); }
            if (a.activate) { openInTimeline(seq); }
            var clips = [];
            walk(seq, function (clip, i) { clips.push(i); }, a.includeRendered !== false);
            clips.sort(function (x, y) { return x.startSeconds - y.startSeconds; });
            var io = inOut(seq);
            for (var k = 0; k < clips.length; k++) {
                clips[k].inRange = (clips[k].endSeconds > io.inSeconds && clips[k].startSeconds < io.outSeconds);
            }
            var tb = Number(seq.timebase);
            return ok({
                sequence: { id: String(seq.sequenceID), name: seq.name },
                projectPath: app.project.path,
                fps: (tb > 0 ? TICKS_PER_SECOND / tb : null),
                inSeconds: io.inSeconds, outSeconds: io.outSeconds,
                clips: clips
            });
        } catch (e) { return err(e); }
    }

    // args { sequenceId, keys?: ["V|<track>|<start ticks>"], rendered?, movePlayhead? = true }
    // Opens the sequence, clears its selection and selects the matching live
    // (or, with rendered, already-rendered) Dynamic Link clips.
    function select(json) {
        try {
            var a = parseArgs(json), i;
            var seq = sequenceById(a.sequenceId);
            if (!seq) { return err("Sequence not found."); }
            var keys = null;
            if (a.keys && a.keys.length) { keys = {}; for (i = 0; i < a.keys.length; i++) { keys[a.keys[i]] = true; } }
            var wantRendered = (a.rendered === true);

            openInTimeline(seq);

            var cleared = false;
            try {
                var sel = seq.getSelection();
                if (sel) {
                    for (i = 0; i < sel.length; i++) { sel[i].setSelected(false, true); }
                    cleared = true;
                }
            } catch (e1) {}
            if (!cleared) {
                var all = [seq.videoTracks, seq.audioTracks];
                for (var g = 0; g < 2; g++) {
                    for (var u = 0, nu = all[g].numTracks; u < nu; u++) {
                        var cl = all[g][u].clips;
                        for (var d = 0, nd = cl.numItems; d < nd; d++) { if (cl[d].isSelected()) { cl[d].setSelected(false, true); } }
                    }
                }
            }

            // Keys name their track, so only those tracks need walking.
            var onlyTracks = null;
            if (keys) { onlyTracks = {}; for (var k in keys) { if (keys.hasOwnProperty(k)) { onlyTracks[k.split("|")[1]] = true; } } }

            var selected = 0, firstTicks = null, classify = classifier(false);
            var tracks = seq.videoTracks;
            for (var t = 0, nt = tracks.numTracks; t < nt; t++) {
                if (onlyTracks && !onlyTracks[String(t)]) { continue; }
                var clips = tracks[t].clips;
                for (var c = 0, nc = clips.numItems; c < nc; c++) {
                    var clip = clips[c];
                    var pi = clip.projectItem;
                    if (!pi) { continue; }
                    var cls = classify(pi);
                    if (!cls.dl || cls.rendered !== wantRendered) { continue; }
                    var ticks = clip.start.ticks;
                    if (keys && keys["V|" + t + "|" + ticks] !== true) { continue; }
                    clip.setSelected(true, true);
                    selected++;
                    if (firstTicks === null || Number(ticks) < Number(firstTicks)) { firstTicks = ticks; }
                }
            }
            if (firstTicks !== null && a.movePlayhead !== false) { seq.setPlayerPosition(firstTicks); }
            return ok({ sequenceId: String(seq.sequenceID), sequenceName: seq.name, selected: selected });
        } catch (e) { return err(e); }
    }

    // "<active sequence id>|<project path>" — cheap change detection for the panel.
    function whoami() {
        try {
            var s = app.project.activeSequence;
            return (s ? String(s.sequenceID) : "") + "|" + app.project.path;
        } catch (e) { return "|"; }
    }

    return { version: VERSION, info: info, find: find, select: select, whoami: whoami };
}());
