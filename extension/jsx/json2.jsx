/*
 * Minimal JSON polyfill for ExtendScript (ES3 engine in Premiere).
 * Provides JSON.stringify and JSON.parse if the engine lacks them.
 * Trimmed from Douglas Crockford's public-domain json2.js.
 */
if (typeof JSON !== "object") { JSON = {}; }

(function () {
    var escapable = /[\\\"\x00-\x1f\x7f-\x9f]/g,
        meta = {
            "\b": "\\b", "\t": "\\t", "\n": "\\n",
            "\f": "\\f", "\r": "\\r", "\"": "\\\"", "\\": "\\\\"
        };

    function quote(string) {
        escapable.lastIndex = 0;
        return "\"" + String(string).replace(escapable, function (a) {
            var c = meta[a];
            return typeof c === "string"
                ? c
                : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
        }) + "\"";
    }

    function str(key, holder) {
        var i, k, v, length, partial, value = holder[key];

        switch (typeof value) {
        case "string":
            return quote(value);
        case "number":
            return isFinite(value) ? String(value) : "null";
        case "boolean":
            return String(value);
        case "object":
            if (!value) { return "null"; }
            partial = [];
            if (Object.prototype.toString.apply(value) === "[object Array]") {
                length = value.length;
                for (i = 0; i < length; i += 1) {
                    partial[i] = str(i, value) || "null";
                }
                return "[" + partial.join(",") + "]";
            }
            for (k in value) {
                if (Object.prototype.hasOwnProperty.call(value, k)) {
                    v = str(k, value);
                    if (v) { partial.push(quote(k) + ":" + v); }
                }
            }
            return "{" + partial.join(",") + "}";
        }
        return "null";
    }

    if (typeof JSON.stringify !== "function") {
        JSON.stringify = function (value) {
            return str("", { "": value });
        };
    }

    if (typeof JSON.parse !== "function") {
        JSON.parse = function (text) {
            text = String(text);
            if (/^[\],:{}\s]*$/.test(
                    text.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
                        .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
                        .replace(/(?:^|:|,)(?:\s*\[)+/g, ""))) {
                return eval("(" + text + ")");
            }
            throw new SyntaxError("JSON.parse");
        };
    }
}());
