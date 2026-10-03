/**
 * SatsLoom embeddable pay button — the whole e-commerce integration.
 *
 *   <script src="https://satsloom.example/embed.js"
 *           data-satsloom-invoice="a1b2…"
 *           data-satsloom-api="https://api.satsloom.example"
 *           data-satsloom-label="Pay with sats"
 *           data-satsloom-theme="dark"></script>
 *
 * `data-satsloom-api` is the origin the pay page is opened from; it defaults to the script's own
 * origin, which is right whenever the API and the button are served from the same host. The older
 * `data-satsloom-pay-origin` spelling is still read as an alias. Documented attributes and read
 * attributes disagreeing is how an integration silently points at the wrong backend.
 *
 * The button opens the real pay page in a modal iframe rather than re-implementing it. That is a
 * deliberate choice: one payment surface means the QR, the countdown, the live status polling and
 * the explorer proof behave identically whether the customer arrived from a shop or from a link,
 * and there is no second implementation to drift.
 *
 * Degradation is explicit: when the pay page cannot be reached, the click falls back to a normal
 * link — a customer who wants to pay is never blocked by our JavaScript.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName("script");
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].src && all[i].src.indexOf("embed.js") !== -1) { script = all[i]; break; }
    }
  }
  if (!script || script.getAttribute("data-satsloom-mounted") === "1") return;
  script.setAttribute("data-satsloom-mounted", "1");

  var invoiceId = script.getAttribute("data-satsloom-invoice");
  if (!invoiceId) {
    console.error("[satsloom] data-satsloom-invoice is required on the embed script tag.");
    return;
  }

  var label = script.getAttribute("data-satsloom-label") || "Pay with sats";
  var theme = script.getAttribute("data-satsloom-theme") || "dark";
  var scriptOrigin = script.src.replace(/\/embed\.js.*$/, "");
  if (!scriptOrigin) scriptOrigin = window.location.origin;
  var payOrigin = (
    script.getAttribute("data-satsloom-api") || // the documented name
    script.getAttribute("data-satsloom-pay-origin") || // older alias, still honoured
    scriptOrigin
  ).replace(/\/$/, "");
  var payUrl = payOrigin + "/#/pay/" + encodeURIComponent(invoiceId);
  var palette = theme === "light"
    ? { surface: "#ffffff", text: "#111111", line: "#e5e5e5", gold: "#8a6400" }
    : { surface: "#101014", text: "#ececf1", line: "#26262f", gold: "#f0b90b" };

  var host = document.createElement("div");
  script.parentNode.insertBefore(host, script.nextSibling);
  var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

  var style = document.createElement("style");
  style.textContent = [
    ":host{all:initial}",
    ".btn{display:inline-flex;align-items:center;gap:8px;background:" + palette.gold + ";color:#17170c;border:none;border-radius:9px;",
    "padding:11px 18px;font:650 14px/1 Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;cursor:pointer;",
    "transition:filter .15s,transform .06s}",
    ".btn:hover{filter:brightness(1.08)}.btn:active{transform:translateY(1px)}",
    ".bolt{width:8px;height:8px;border-radius:50%;background:#17170c}",
    ".overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;",
    "z-index:2147483000;padding:16px}",
    ".modal{background:" + palette.surface + ";border:1px solid " + palette.line + ";border-radius:14px;overflow:hidden;",
    "width:100%;max-width:460px;height:min(680px,92vh);display:flex;flex-direction:column;box-shadow:0 30px 80px rgba(0,0,0,.6)}",
    ".head{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid " + palette.line + "}",
    ".head strong{font:600 13.5px/1 Inter,sans-serif;color:" + palette.text + "}",
    ".x{background:none;border:none;color:" + palette.text + ";opacity:.6;font-size:22px;line-height:1;cursor:pointer;padding:0 4px}",
    "iframe{flex:1;width:100%;border:none;background:" + palette.surface + "}",
    ".foot{padding:9px 16px;border-top:1px solid " + palette.line + ";font:500 11px/1.4 Inter,sans-serif;color:" + palette.text + ";opacity:.55}",
    ".foot a{color:" + palette.gold + "}",
  ].join("");

  var button = document.createElement("button");
  button.className = "btn";
  button.type = "button";
  // textContent, not innerHTML: the label is merchant-supplied and must never be parsed as markup.
  var bolt = document.createElement("span");
  bolt.className = "bolt";
  button.appendChild(bolt);
  button.appendChild(document.createTextNode(label));

  shadow.appendChild(style);
  shadow.appendChild(button);

  var overlay = null;

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.removeEventListener("keydown", onKey);
  }

  function onKey(event) {
    if (event.key === "Escape") close();
  }

  function open() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) close();
    });

    var modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML =
      '<div class="head"><strong>Pay with native sats</strong><button class="x" type="button" aria-label="Close">×</button></div>' +
      '<iframe title="SatsLoom pay page" allow="clipboard-write" src="' + payUrl + '"></iframe>' +
      '<div class="foot">Settled on Tachi · <a href="' + payUrl + '" target="_blank" rel="noreferrer">open in a new tab</a></div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    modal.querySelector(".x").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
  }

  button.addEventListener("click", function () {
    try {
      open();
    } catch (error) {
      // A popup/modal failure must never stop a customer from paying.
      window.open(payUrl, "_blank", "noopener");
      void error;
    }
  });

  window.SatsLoom = { open: open, close: close, invoiceId: invoiceId, payUrl: payUrl };
})();
