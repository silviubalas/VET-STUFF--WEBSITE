/* ============================================================
   STUFFIE — Widget de chat pentru website VET STUFF
   ------------------------------------------------------------
   Integrare: adaugă în pagina ta, înainte de </body>:

     <script>
     window.STUFFIE_CONFIG = {
       webhookUrl: "/api/booking?intent=stuffie"
     };
     </script>
     <script src="stuffie-widget.js"></script>

   webhookUrl e deja setat pe serverul public de producție.
   ============================================================ */
(function () {
  "use strict";

  // ---- Config ----
  var CFG = window.STUFFIE_CONFIG || {};
  var WEBHOOK_URL = CFG.webhookUrl || "/api/booking?intent=stuffie";
  var CANAL = "website";

  // Culori brand VET STUFF
  var C = {
    red: "#E31B23",
    redHover: "#A8231D",
    navy: "#1B2A4A",
    navyDark: "#151F38",
    grey: "#8C8FA0",
    botBg: "#F4F5F7",
    userBg: "#1B2A4A"
  };

  // ---- user_id/device_id persistent (pentru memorie si anti-abuz anonim) ----
  function getUserId() {
    var k = "stuffie_user_id";
    var v = localStorage.getItem(k);
    if (!v) {
      v = "web-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(k, v);
    }
    return v;
  }
  var USER_ID = getUserId();
  var DEVICE_ID = USER_ID;

  // ---- Ascunde marcajele interne de escaladare din textul către client ----
  function cleanText(t) {
    if (!t) return "";
    return t.replace(/\[ESCALADARE:[A-Z]+\]/g, "").trim();
  }

  // ---- Mini-markdown sigur (escape HTML, apoi bold/italic/liste/separatoare) ----
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function renderMarkdown(t) {
    var lines = escapeHtml(t).split("\n");
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^\s*[-—]{3,}\s*$/.test(ln)) { out.push("<hr class='stuffie-hr'>"); continue; } // --- -> separator
      ln = ln.replace(/^\s*[-*]\s+/, "• ");                       // bullet
      ln = ln.replace(/^\s*\d+\.\s+/, function (m) { return m.trim() + " "; }); // liste numerotate
      out.push(ln);
    }
    var html = out.join("\n");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"); // **bold**
    html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>"); // *italic*
    return html;
  }

  // ---- Stiluri ----
  var css = `
  #stuffie-launcher{position:fixed;bottom:24px;right:24px;width:60px;height:60px;border-radius:50%;
    background:${C.red};color:#fff;border:none;cursor:pointer;font-size:28px;line-height:60px;
    box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:999999;transition:transform .15s,background .15s;}
  #stuffie-launcher:hover{background:${C.redHover};transform:scale(1.05);}
  #stuffie-panel{position:fixed;bottom:96px;right:24px;width:370px;max-width:calc(100vw - 32px);
    height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;display:none;
    flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.28);z-index:999999;
    font-family:'DM Sans',system-ui,-apple-system,sans-serif;}
  #stuffie-panel.open{display:flex;}
  #stuffie-head{background:${C.navy};color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px;}
  #stuffie-head .av{width:38px;height:38px;border-radius:50%;background:${C.red};display:flex;
    align-items:center;justify-content:center;font-size:20px;flex:0 0 auto;}
  #stuffie-head .tt{font-weight:700;font-size:15px;line-height:1.1;}
  #stuffie-head .st{font-size:11.5px;opacity:.8;}
  #stuffie-head .x{margin-left:auto;background:none;border:none;color:#fff;font-size:20px;cursor:pointer;opacity:.85;}
  #stuffie-head .x:hover{opacity:1;}
  #stuffie-msgs{flex:1;overflow-y:auto;padding:16px;background:#fff;display:flex;flex-direction:column;gap:10px;}
  .stuffie-row{display:flex;}
  .stuffie-row.bot{justify-content:flex-start;}
  .stuffie-row.user{justify-content:flex-end;}
  .stuffie-bub{max-width:80%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.45;
    white-space:pre-wrap;word-wrap:break-word;}
  .stuffie-row.bot .stuffie-bub{background:${C.botBg};color:#1a1a1a;border-bottom-left-radius:4px;}
  .stuffie-row.user .stuffie-bub{background:${C.userBg};color:#fff;border-bottom-right-radius:4px;}
  .stuffie-bub strong{font-weight:700;}
  .stuffie-bub .stuffie-hr{border:none;border-top:1px solid #dcdde3;margin:8px 0;}
  .stuffie-bub a{color:${C.red};}
  .stuffie-typing{display:flex;gap:4px;padding:12px 14px;}
  .stuffie-typing span{width:7px;height:7px;border-radius:50%;background:${C.grey};opacity:.6;
    animation:stuffieBlink 1.2s infinite;}
  .stuffie-typing span:nth-child(2){animation-delay:.2s;}
  .stuffie-typing span:nth-child(3){animation-delay:.4s;}
  @keyframes stuffieBlink{0%,60%,100%{opacity:.25;}30%{opacity:.9;}}
  #stuffie-foot{border-top:1px solid #ececf0;padding:10px;display:flex;gap:8px;align-items:flex-end;background:#fff;}
  #stuffie-input{flex:1;border:1px solid #d8d9e0;border-radius:12px;padding:10px 12px;font-size:14px;
    font-family:inherit;resize:none;max-height:96px;outline:none;}
  #stuffie-input:focus{border-color:${C.navy};}
  #stuffie-send{background:${C.red};color:#fff;border:none;border-radius:12px;width:42px;height:42px;
    cursor:pointer;font-size:18px;flex:0 0 auto;}
  #stuffie-send:hover{background:${C.redHover};}
  #stuffie-send:disabled{opacity:.5;cursor:default;}
  `;

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }

  function init() {
    var style = el("style"); style.textContent = css; document.head.appendChild(style);

    var launcher = el("button", { id: "stuffie-launcher", title: "Întreabă-l pe STUFFIE", "aria-label": "Chat STUFFIE" }, "🐾");
    var panel = el("div", { id: "stuffie-panel" });
    panel.innerHTML = `
      <div id="stuffie-head">
        <div class="av">🐾</div>
        <div>
          <div class="tt">STUFFIE</div>
          <div class="st">VET STUFF · răspunde 24/7</div>
        </div>
        <button class="x" aria-label="Închide">×</button>
      </div>
      <div id="stuffie-msgs"></div>
      <div id="stuffie-foot">
        <textarea id="stuffie-input" rows="1" placeholder="Scrie un mesaj..."></textarea>
        <button id="stuffie-send" aria-label="Trimite">➤</button>
      </div>`;

    document.body.appendChild(launcher);
    document.body.appendChild(panel);

    var msgs = panel.querySelector("#stuffie-msgs");
    var input = panel.querySelector("#stuffie-input");
    var sendBtn = panel.querySelector("#stuffie-send");
    var greeted = false;

    function scrollDown() { msgs.scrollTop = msgs.scrollHeight; }

    function addMsg(text, who) {
      var row = el("div", { "class": "stuffie-row " + who });
      var bub = el("div", { "class": "stuffie-bub" });
      if (who === "bot") { bub.innerHTML = renderMarkdown(text); }
      else { bub.textContent = text; }
      row.appendChild(bub);
      msgs.appendChild(row);
      scrollDown();
    }

    function showTyping() {
      var row = el("div", { "class": "stuffie-row bot", id: "stuffie-typingrow" });
      row.innerHTML = '<div class="stuffie-bub stuffie-typing"><span></span><span></span><span></span></div>';
      msgs.appendChild(row); scrollDown();
    }
    function hideTyping() {
      var t = document.getElementById("stuffie-typingrow");
      if (t) t.remove();
    }

    function openPanel() {
      panel.classList.add("open");
      if (!greeted) {
        greeted = true;
        addMsg("🐾 Bună! Sunt STUFFIE, asistentul VET STUFF. Cu ce te pot ajuta azi — programare, vaccin, o întrebare despre animăluțul tău? ❤️", "bot");
      }
      input.focus();
    }
    function closePanel() { panel.classList.remove("open"); }

    async function send() {
      var text = input.value.trim();
      if (!text) return;
      input.value = ""; input.style.height = "auto";
      addMsg(text, "user");
      sendBtn.disabled = true;
      showTyping();
      try {
        var res = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ canal: CANAL, user_id: USER_ID, deviceId: DEVICE_ID, mesaj: text })
        });
        var data = await res.json().catch(function () { return {}; });
        hideTyping();
        var reply = cleanText(data.raspuns) || "Hmm, n-am putut răspunde acum. Te rog încearcă din nou sau scrie-ne pe vet-stuff.ro/contact. 🐾";
        addMsg(reply, "bot");
      } catch (e) {
        hideTyping();
        addMsg("Momentan nu reușesc să mă conectez. Te rog scrie-ne pe vet-stuff.ro/contact sau încearcă din nou. 🐾", "bot");
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    launcher.addEventListener("click", function () {
      panel.classList.contains("open") ? closePanel() : openPanel();
    });
    panel.querySelector(".x").addEventListener("click", closePanel);
    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    input.addEventListener("input", function () {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 96) + "px";
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
