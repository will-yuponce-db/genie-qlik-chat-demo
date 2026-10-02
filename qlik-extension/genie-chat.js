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

  function render($element, backendUrl) {
    backendUrl = (backendUrl || "").replace(/\/$/, "");
    $element.html(
      '<div class="gc-wrap" style="display:flex;flex-direction:column;height:100%;font:14px system-ui,sans-serif;">' +
      '  <div class="gc-log" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;"></div>' +
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
      el.style.maxWidth = "90%";
      el.style.padding = "8px 10px";
      el.style.borderRadius = "10px";
      el.style.whiteSpace = "pre-wrap";
      if (cls === "user") { el.style.alignSelf = "flex-end"; el.style.background = "#2272b4"; el.style.color = "#fff"; }
      else if (cls === "error") { el.style.alignSelf = "flex-start"; el.style.background = "#b4232a"; el.style.color = "#fff"; }
      else { el.style.alignSelf = "flex-start"; el.style.background = "#e9ebef"; el.style.color = "#1b1f24"; }
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    // Minimal, safe markdown: escape HTML first, then render **bold** / *italic*.
    function mdToHtml(s) {
      s = (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      return s;
    }

    function renderAnswer(data) {
      var el = bubble("bot", "");
      var ans = document.createElement("div");
      ans.innerHTML = mdToHtml(data.answer || "(no text answer)");
      el.appendChild(ans);
      if (data.columns && data.rows && data.rows.length) {
        var table = document.createElement("table");
        table.style.borderCollapse = "collapse";
        table.style.marginTop = "6px";
        table.style.fontSize = "12px";
        var head = document.createElement("tr");
        data.columns.forEach(function (c) {
          var th = document.createElement("th");
          th.textContent = c; th.style.border = "1px solid #d6dae1"; th.style.padding = "3px 6px";
          head.appendChild(th);
        });
        table.appendChild(head);
        data.rows.slice(0, 50).forEach(function (r) {
          var tr = document.createElement("tr");
          r.forEach(function (v) {
            var td = document.createElement("td");
            td.textContent = v; td.style.border = "1px solid #d6dae1"; td.style.padding = "3px 6px";
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        el.appendChild(table);
      }
      if (data.sql) {
        var det = document.createElement("details");
        det.innerHTML = "<summary style='cursor:pointer;color:#5a6472;font-size:12px;'>View SQL</summary>";
        var pre = document.createElement("pre");
        pre.textContent = data.sql;
        pre.style.background = "#0f1420"; pre.style.color = "#e6edf3"; pre.style.padding = "8px"; pre.style.borderRadius = "6px"; pre.style.overflowX = "auto";
        det.appendChild(pre);
        el.appendChild(det);
      }
    }

    form.onsubmit = function (e) {
      e.preventDefault();
      var question = input.value.trim();
      if (!question) return;
      if (!backendUrl) { bubble("error", "Set the Backend URL in the extension properties."); return; }
      bubble("user", question);
      input.value = "";
      send.disabled = true;
      var thinking = bubble("bot", "Genie is thinking...");

      fetch(backendUrl + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question, conversation_id: conversationId })
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
        .then(function (res) {
          thinking.remove();
          if (!res.ok || res.data.error) {
            bubble("error", res.data.error || res.data.detail || ("Request failed: " + res.status));
          } else {
            conversationId = res.data.conversation_id || conversationId;
            renderAnswer(res.data);
          }
        })
        .catch(function (err) { thinking.remove(); bubble("error", "Network error: " + err.message); })
        .finally(function () { send.disabled = false; input.focus(); });
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
