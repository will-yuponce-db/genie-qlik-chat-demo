/*
 * Genie Chat - Qlik Sense visualization extension.
 *
 * Renders an inline chat panel in a Qlik sheet and calls the backend's /api/chat.
 * No Databricks credentials live here - the backend holds the service principal.
 *
 * Install (Qlik Cloud): zip this folder, upload under Administration > Extensions,
 * then add "Genie Chat" to a sheet and set the Backend URL in the properties panel.
 * NOTE: add the backend domain to the tenant CSP allowlist (connect-src) so the
 * browser is allowed to call it cross-origin.
 */
define([], function () {
  "use strict";

  // Scoped styles for answer layout + spinner. Injected once; all classes are gc-
  // prefixed so nothing leaks into the host Qlik sheet.
  var CSS =
    "@keyframes gc-spin{to{transform:rotate(360deg)}}" +
    ".gc-answer{display:flex;flex-direction:column;gap:10px;min-width:0;box-sizing:border-box;}" +
    ".gc-md>*{margin:0;}.gc-md>*+*{margin-top:8px;}" +
    ".gc-md ul,.gc-md ol{padding-left:18px;}.gc-md li+li{margin-top:4px;}" +
    ".gc-table-wrap{overflow:auto;max-height:260px;max-width:100%;border:1px solid #d6dae1;border-radius:6px;background:#fff;}" +
    ".gc-table{border-collapse:collapse;font-size:12px;width:max-content;min-width:100%;}" +
    ".gc-table th{position:sticky;top:0;background:#f4f6f8;color:#3b4552;font-weight:600;text-align:left;border-bottom:1px solid #d6dae1;}" +
    ".gc-table th,.gc-table td{padding:5px 8px;white-space:nowrap;}" +
    ".gc-table td{border-bottom:1px solid #eef1f4;}" +
    ".gc-table tr:nth-child(even) td{background:#fafbfc;}" +
    ".gc-table td.gc-num{text-align:right;font-variant-numeric:tabular-nums;}" +
    ".gc-caption{font-size:11px;color:#6b7280;margin-top:-4px;}" +
    ".gc-sql summary{list-style:none;display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;font-weight:600;color:#3b4552;" +
    "padding:4px 10px;border:1px solid #c9cfd8;border-radius:999px;background:#fff;user-select:none;}" +
    ".gc-sql summary::-webkit-details-marker{display:none;}" +
    ".gc-sql summary:hover{color:#2272b4;border-color:#2272b4;}" +
    ".gc-sql summary .gc-arrow{display:inline-block;transition:transform .15s;}" +
    ".gc-sql[open] summary .gc-arrow{transform:rotate(90deg);}" +
    ".gc-sql pre{margin:8px 0 0;background:#0f1420;color:#e6edf3;padding:10px;border-radius:6px;max-height:220px;overflow:auto;" +
    "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;}" +
    ".gc-thinking{display:flex;align-items:center;gap:10px;color:#3b4552;}" +
    ".gc-spinner{width:16px;height:16px;flex:none;border:2px solid #c9d6e3;border-top-color:#2272b4;border-radius:50%;animation:gc-spin .8s linear infinite;}" +
    ".gc-elapsed{color:#6b7280;font-variant-numeric:tabular-nums;}";

  function injectStyles() {
    if (document.getElementById("gc-style")) return;
    var st = document.createElement("style");
    st.id = "gc-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function render($element, backendUrl) {
    backendUrl = (backendUrl || "").replace(/\/$/, "");
    injectStyles();
    $element.html(
      '<div class="gc-wrap" style="display:flex;flex-direction:column;height:100%;font:14px system-ui,sans-serif;">' +
      '  <div class="gc-log" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:14px;"></div>' +
      '  <form class="gc-form" style="display:flex;gap:8px;padding:10px;border-top:1px solid #d6dae1;">' +
      '    <input class="gc-q" type="text" placeholder="Ask about the data..." style="flex:1;padding:8px;border:1px solid #d6dae1;border-radius:6px;" />' +
      '    <button class="gc-send" type="submit" style="padding:8px 14px;border:none;border-radius:6px;background:#2272b4;color:#fff;font-weight:600;cursor:pointer;">Send</button>' +
      '  </form>' +
      '</div>'
    );

    var root = $element[0];
    var log = root.querySelector(".gc-log");
    var form = root.querySelector(".gc-form");
    var input = root.querySelector(".gc-q");
    var send = root.querySelector(".gc-send");
    var conversationId = null;

    function bubble(cls, text) {
      var el = document.createElement("div");
      el.textContent = text;
      el.style.maxWidth = cls === "user" ? "90%" : "92%";
      el.style.padding = cls === "user" ? "8px 10px" : "10px 12px";
      el.style.boxSizing = "border-box";
      el.style.borderRadius = "10px";
      el.style.whiteSpace = "pre-wrap";
      if (cls === "user") { el.style.alignSelf = "flex-end"; el.style.background = "#2272b4"; el.style.color = "#fff"; }
      else if (cls === "error") { el.style.alignSelf = "flex-start"; el.style.background = "#b4232a"; el.style.color = "#fff"; }
      else { el.style.alignSelf = "flex-start"; el.style.background = "#e9ebef"; el.style.color = "#1b1f24"; }
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    // Minimal, safe markdown: escape HTML first, then render **bold** / *italic*,
    // "- " / "1. " lists, and blank-line-separated paragraphs.
    function inlineMd(s) {
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      return s;
    }

    function mdToHtml(s) {
      s = (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      var out = [], para = [], list = null;
      function flushPara() { if (para.length) { out.push("<p>" + para.map(inlineMd).join("<br>") + "</p>"); para = []; } }
      function closeList() { if (list) { out.push("</" + list + ">"); list = null; } }
      s.split("\n").forEach(function (line) {
        var ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        var m = ul || ol;
        if (m) {
          flushPara();
          var type = ul ? "ul" : "ol";
          if (list !== type) { closeList(); out.push("<" + type + ">"); list = type; }
          out.push("<li>" + inlineMd(m[1]) + "</li>");
        } else if (!line.trim()) {
          flushPara(); closeList();
        } else {
          closeList(); para.push(line);
        }
      });
      flushPara(); closeList();
      return out.join("");
    }

    var MAX_ROWS = 50;
    var NUM_RE = /^-?\d[\d,]*(\.\d+)?([eE][-+]?\d+)?$/;

    function renderAnswer(data) {
      var el = bubble("bot", "");
      el.style.whiteSpace = "normal";
      el.className = "gc-answer";
      var ans = document.createElement("div");
      ans.className = "gc-md";
      ans.innerHTML = mdToHtml(data.answer || "(no text answer)");
      el.appendChild(ans);
      if (data.columns && data.rows && data.rows.length) {
        var wrap = document.createElement("div");
        wrap.className = "gc-table-wrap";
        var table = document.createElement("table");
        table.className = "gc-table";
        var thead = document.createElement("thead");
        var head = document.createElement("tr");
        data.columns.forEach(function (c) {
          var th = document.createElement("th");
          th.textContent = c;
          head.appendChild(th);
        });
        thead.appendChild(head);
        table.appendChild(thead);
        var tbody = document.createElement("tbody");
        data.rows.slice(0, MAX_ROWS).forEach(function (r) {
          var tr = document.createElement("tr");
          r.forEach(function (v) {
            var td = document.createElement("td");
            td.textContent = v == null ? "" : v;
            if (v != null && NUM_RE.test(String(v))) td.className = "gc-num";
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        el.appendChild(wrap);
        var cap = document.createElement("div");
        cap.className = "gc-caption";
        var n = data.rows.length;
        cap.textContent = n > MAX_ROWS ? "Showing " + MAX_ROWS + " of " + n + " rows" : n + (n === 1 ? " row" : " rows");
        el.appendChild(cap);
      }
      if (data.sql) {
        var det = document.createElement("details");
        det.className = "gc-sql";
        det.innerHTML = "<summary><span class='gc-arrow'>&#9656;</span>View SQL</summary>";
        var pre = document.createElement("pre");
        pre.textContent = data.sql;
        det.appendChild(pre);
        el.appendChild(det);
      }
      log.scrollTop = log.scrollHeight;
    }

    var PHASES = ["Understanding your question…", "Writing SQL…", "Running the query…", "Summarizing results…"];

    // Animated loading bubble. Phases are timed, not real Genie status (the backend
    // runs start -> poll -> fetch in one blocking request). Returns a stop() fn.
    function thinkingBubble() {
      var el = bubble("bot", "");
      el.innerHTML = "<div class='gc-thinking'><span class='gc-spinner'></span>" +
        "<span class='gc-phase'></span><span class='gc-elapsed'></span></div>";
      var phaseEl = el.querySelector(".gc-phase");
      var elapsedEl = el.querySelector(".gc-elapsed");
      var i = 0, start = Date.now();
      phaseEl.textContent = PHASES[0];
      var phaseTimer = setInterval(function () {
        if (i < PHASES.length - 1) phaseEl.textContent = PHASES[++i];
      }, 2500);
      var tick = setInterval(function () {
        elapsedEl.textContent = "· " + Math.floor((Date.now() - start) / 1000) + "s";
      }, 1000);
      return function stop() { clearInterval(phaseTimer); clearInterval(tick); el.remove(); };
    }

    form.onsubmit = function (e) {
      e.preventDefault();
      var question = input.value.trim();
      if (!question) return;
      if (!backendUrl) { bubble("error", "Set the Backend URL in the extension properties."); return; }
      bubble("user", question);
      input.value = "";
      send.disabled = true;
      input.disabled = true;
      send.textContent = "…";
      var stopThinking = thinkingBubble();

      fetch(backendUrl + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question, conversation_id: conversationId })
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
        .then(function (res) {
          stopThinking();
          if (!res.ok || res.data.error) {
            bubble("error", res.data.error || res.data.detail || ("Request failed: " + res.status));
          } else {
            conversationId = res.data.conversation_id || conversationId;
            renderAnswer(res.data);
          }
        })
        .catch(function (err) { stopThinking(); bubble("error", "Network error: " + err.message); })
        .finally(function () {
          send.disabled = false; input.disabled = false; send.textContent = "Send"; input.focus();
        });
    };
  }

  return {
    definition: {
      type: "items",
      component: "accordion",
      items: {
        settings: {
          uses: "settings",
          items: {
            backend: {
              ref: "props.backendUrl",
              label: "Backend URL (base, e.g. https://cbp-backend.example.gov)",
              type: "string",
              defaultValue: ""
            }
          }
        }
      }
    },
    paint: function ($element, layout) {
      render($element, (layout.props && layout.props.backendUrl) || "");
    }
  };
});
