(function () {
  "use strict";

  const HIGH_VALUE_INR = 200000;
  const MAX_CUMULATIVE_INR = 500000;
  const OPS_PIN_SHA256 = "f0d46929beb4e4095786d5951d13b0d7124f8d6908d1f82922b58b9315cd88a0";
  const STATE_KEY = "orbitpay_hardened_state_v4";
  const GENESIS_HASH = "00000000000000000000000000000000";
  const INIT_POOLS = Object.freeze({ USD: 254500.00, INR: 20680975.35, EUR: 180000.00, GBP: 140000.00 });
  const META = Object.freeze({
    EUR_INR: { from: "EUR", to: "INR", sym: "\u20B9", defaultRec: "Ravi Sharma (INR Local Pool)" },
    USD_INR: { from: "USD", to: "INR", sym: "\u20B9", defaultRec: "Ravi Sharma (INR Local Pool)" },
    GBP_INR: { from: "GBP", to: "INR", sym: "\u20B9", defaultRec: "Ravi Sharma (INR Local Pool)" },
    INR_USD: { from: "INR", to: "USD", sym: "$", defaultRec: "Alex Morgan (USD Local Pool)" },
    USD_EUR: { from: "USD", to: "EUR", sym: "\u20AC", defaultRec: "Lukas Weber (EUR Local Pool)" }
  });

  let pools = { ...INIT_POOLS };
  let rates = { ...OrbitCompliance.DEFAULT_RATES };
  let rateMode = "Live / Initial";
  let pendingTx = null;
  let totalWrongOtpCount = 0;
  let accountLocked = false;
  let dynamicUnlockToken = "";
  let cumulativeInrVolume = 0;
  let recipientVolumes = {};
  let usedDocHashes = [];
  let txHistory = [];
  let prevChainHash = GENESIS_HASH;
  let opsAuthenticated = false;
  let otpCountdown = null;
  let otpSecondsLeft = 60;
  let lastAuditHash = "";
  let sessionNonce = Math.random().toString(36).slice(2, 10).toUpperCase();
  let lastTriggerEl = null;

  const syncChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("orbitpay_sync") : null;

  function broadcastState() {
    if (!syncChannel) return;
    try {
      syncChannel.postMessage({
        type: "STATE_SYNC",
        payload: {
          pools,
          totalWrongOtpCount,
          accountLocked,
          dynamicUnlockToken,
          cumulativeInrVolume,
          recipientVolumes,
          usedDocHashes,
          txHistory,
          prevChainHash
        }
      });
    } catch (e) {}
  }

  function applyStateSnapshot(s) {
    if (!s) return;
    if (s.pools) pools = { ...INIT_POOLS, ...s.pools };
    if (typeof s.totalWrongOtpCount === "number") totalWrongOtpCount = s.totalWrongOtpCount;
    if (typeof s.accountLocked === "boolean") accountLocked = s.accountLocked;
    if (typeof s.dynamicUnlockToken === "string") dynamicUnlockToken = s.dynamicUnlockToken;
    if (typeof s.cumulativeInrVolume === "number") cumulativeInrVolume = s.cumulativeInrVolume;
    if (typeof s.recipientVolumes === "object" && s.recipientVolumes) recipientVolumes = s.recipientVolumes;
    if (Array.isArray(s.usedDocHashes)) usedDocHashes = s.usedDocHashes;
    if (Array.isArray(s.txHistory)) txHistory = s.txHistory;
    if (typeof s.prevChainHash === "string") prevChainHash = s.prevChainHash;
  }

  if (syncChannel) {
    syncChannel.onmessage = ev => {
      if (ev && ev.data && ev.data.type === "STATE_SYNC") {
        applyStateSnapshot(ev.data.payload);
        saveState(false);
        renderPools();
        syncLockUI();
        refreshQuote();
      }
    };
  }

  function saveState(shouldBroadcast = true) {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify({
        pools,
        totalWrongOtpCount,
        accountLocked,
        dynamicUnlockToken,
        cumulativeInrVolume,
        recipientVolumes,
        usedDocHashes,
        txHistory,
        prevChainHash
      }));
    } catch (e) {}
    if (shouldBroadcast) broadcastState();
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (!raw) return;
      applyStateSnapshot(JSON.parse(raw));
    } catch (e) {}
  }

  function currentCorridor() { return document.getElementById("corridor").value; }
  function getActiveRate() { return rates[currentCorridor()]; }

  function formatNum(n, dec = 2) {
    return Number(n).toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function getEffectiveFeeRate(corridor) {
    const dest = META[corridor].to;
    const ratio = pools[dest] / INIT_POOLS[dest];
    return ratio < 0.20 ? 0.0105 : 0.004;
  }

  function renderPools() {
    document.getElementById("usPool").textContent = "$" + pools.USD.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById("inPool").textContent = "\u20B9" + formatNum(pools.INR, 2);
    document.getElementById("euPool").textContent = "\u20AC" + pools.EUR.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById("ukPool").textContent = "\u00A3" + pools.GBP.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    for (const cur of Object.keys(INIT_POOLS)) {
      const card = document.getElementById("poolCard_" + cur);
      if (card) card.classList.toggle("low", (pools[cur] / INIT_POOLS[cur]) < 0.20);
    }
    document.getElementById("capPill").textContent = "Session Vol: \u20B9" + formatNum(cumulativeInrVolume, 0) + " / \u20B95L";
  }

  function syncLockUI() {
    const btn = document.getElementById("bankApproveBtn");
    btn.classList.toggle("hidden", !accountLocked);
    const s2 = document.getElementById("s2");
    if (accountLocked) {
      s2.textContent = "LOCKED (3/3)";
      s2.className = "bad";
    } else {
      s2.textContent = totalWrongOtpCount + "/3 Failed";
      s2.className = totalWrongOtpCount > 0 ? "run" : "wait";
    }
  }

  function openModal(modalEl, focusEl) {
    lastTriggerEl = document.activeElement;
    modalEl.classList.add("open");
    if (focusEl) focusEl.focus();
  }

  function closeModal(modalEl) {
    modalEl.classList.remove("open");
    if (lastTriggerEl && typeof lastTriggerEl.focus === "function") {
      lastTriggerEl.focus();
    }
  }

  function trapModalTab(modalEl, e) {
    if (e.key !== "Tab") return;
    const focusables = Array.from(modalEl.querySelectorAll("button:not([disabled]), input:not([disabled])"));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function toggleStealth() {
    const p = document.getElementById("stealthPanel");
    if (p.classList.contains("open")) {
      p.classList.remove("open");
      return;
    }
    if (!opsAuthenticated) {
      document.getElementById("opsPinInput").value = "";
      document.getElementById("opsErr").textContent = "";
      openModal(document.getElementById("opsAuthModal"), document.getElementById("opsPinInput"));
      return;
    }
    p.classList.add("open");
  }

  async function verifyOpsAccess() {
    const pin = document.getElementById("opsPinInput").value.trim().toUpperCase();
    const enteredDigest = await sha256Hex(pin);
    if (enteredDigest !== OPS_PIN_SHA256) {
      document.getElementById("opsErr").textContent = "Invalid Ops PIN.";
      return;
    }
    opsAuthenticated = true;
    closeModal(document.getElementById("opsAuthModal"));
    document.getElementById("stealthPanel").classList.add("open");
  }

  function appendSafeLogItem(container, badgeText, isBad, messageText) {
    if (container.dataset.empty !== "false") {
      container.textContent = "";
      container.dataset.empty = "false";
    }
    const row = document.createElement("div");
    row.className = "log-item";

    const left = document.createElement("div");
    const badge = document.createElement("span");
    badge.className = isBad ? "bad" : "ok";
    badge.textContent = "[" + badgeText + "] ";
    const msgNode = document.createTextNode(messageText);
    left.appendChild(badge);
    left.appendChild(msgNode);

    const right = document.createElement("div");
    right.className = "muted";
    right.textContent = new Date().toLocaleTimeString();

    row.appendChild(left);
    row.appendChild(right);
    container.prepend(row);
  }

  function addSilentLog(severity, detail) {
    const box = document.getElementById("stealthLogs");
    appendSafeLogItem(box, severity, true, detail + " | Session: #" + sessionNonce);
  }

  function addLog(tag, text, isBad) {
    const logList = document.getElementById("logList");
    appendSafeLogItem(logList, tag, isBad, text);
  }

  function onCorridorChange() {
    const c = currentCorridor();
    const m = META[c];
    const lbl = document.getElementById("rateLabel");
    lbl.textContent = "";
    const s1 = document.createElement("span");
    s1.textContent = m.from + " to " + m.to + " Rate";
    const s2 = document.createElement("span");
    s2.className = "lock-tag";
    s2.textContent = "Circuit-Breaker Locked";
    lbl.appendChild(s1);
    lbl.appendChild(s2);

    document.getElementById("rateInput").value = rates[c];
    document.getElementById("rec").value = m.defaultRec;
    refreshQuote();
  }

  function refreshQuote() {
    const c = currentCorridor();
    const m = META[c];
    const r = getActiveRate();
    const feeRate = getEffectiveFeeRate(c);
    const amt = Math.max(0, parseFloat(document.getElementById("amt").value) || 0);
    const recKey = document.getElementById("rec").value.trim().toLowerCase();
    const recVol = recipientVolumes[recKey] || 0;
    const fee = +(amt * feeRate).toFixed(2);
    const payout = +(amt * (1 - feeRate) * r).toFixed(2);
    const swiftEst = (amt * 0.065 + 12).toFixed(2);
    const inrEq = OrbitCompliance.toInr(amt, m.from, rates);
    const projectedCumulative = cumulativeInrVolume + inrEq;
    const projectedRec = recVol + inrEq;

    document.getElementById("rateInput").value = r;
    document.getElementById("rateLine").textContent = "1 " + m.from + " = " + r + " " + m.to;
    document.getElementById("ratePill").textContent = "1 " + m.from + " = " + r + " " + m.to + " (" + rateMode + ")";
    document.getElementById("swiftLine").textContent = swiftEst + " " + m.from + " (3-5 Days)";
    document.getElementById("feeLabel").textContent = feeRate > 0.004
      ? "OrbitPay Mesh Fee (1.05% Rebalance Active):"
      : "OrbitPay Mesh Fee (0.4% base):";
    document.getElementById("feeLine").textContent = fee.toFixed(2) + " " + m.from + " (~180ms)";
    document.getElementById("payoutLine").textContent = m.sym + formatNum(payout, 2) + " " + m.to;

    const docTag = document.getElementById("docReqTag");
    const requiresProof = inrEq > HIGH_VALUE_INR || projectedCumulative > HIGH_VALUE_INR || projectedRec > HIGH_VALUE_INR;
    docTag.textContent = requiresProof ? "Mandatory (Cumulative > \u20B92L)" : "Optional (Cumulative \u2264 \u20B92L)";
    docTag.classList.toggle("warn", requiresProof);
  }

  function applyProviderRates(d) {
    const usdInr = d && d.rates && Number(d.rates.INR);
    const usdEur = d && d.rates && Number(d.rates.EUR);
    const usdGbp = d && d.rates && Number(d.rates.GBP);
    if (!OrbitCompliance.isRateWithinCircuitBreaker("USD_INR", usdInr)) return false;
    rates.USD_INR = +usdInr.toFixed(4);
    rates.INR_USD = +(1 / usdInr).toFixed(6);
    if (usdEur && OrbitCompliance.isRateWithinCircuitBreaker("EUR_INR", usdInr / usdEur)) {
      rates.EUR_INR = +(usdInr / usdEur).toFixed(4);
      rates.USD_EUR = +usdEur.toFixed(4);
    }
    if (usdGbp && OrbitCompliance.isRateWithinCircuitBreaker("GBP_INR", usdInr / usdGbp)) {
      rates.GBP_INR = +(usdInr / usdGbp).toFixed(4);
    }
    return true;
  }

  async function fetchRates(manual = false) {
    const diag = document.getElementById("diag");
    if (manual) diag.textContent = "Racing live FX providers in parallel...";
    const endpoints = [
      { name: "OpenER-API", url: "https://open.er-api.com/v6/latest/USD" },
      { name: "Frankfurter", url: "https://api.frankfurter.app/latest?from=USD&to=INR,EUR,GBP" }
    ];

    const tasks = endpoints.map(async ep => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      try {
        const res = await fetch(ep.url, { cache: "no-store", signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (!applyProviderRates(data)) throw new Error("Circuit breaker rejected");
        return ep.name;
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    });

    try {
      const winner = await Promise.any(tasks);
      rateMode = "Live (" + winner + ")";
      diag.textContent = "Live FX quote verified via " + winner + " (parallel race, circuit-breaker checked).";
    } catch (e) {
      rateMode = "Fallback";
      diag.textContent = "External FX APIs unreachable; using circuit-breaker fallback quote.";
    }
    refreshQuote();
  }

  function setStep(idx, label, cls) {
    const el = document.getElementById("s" + idx);
    const card = document.getElementById("st" + idx);
    el.textContent = label;
    el.className = cls;
    card.className = "step" + (cls === "run" ? " active" : "");
  }

  function resetSteps() {
    setStep(1, "Ready", "wait");
    setStep(3, "Ready", "wait");
    setStep(4, "Ready", "wait");
    syncLockUI();
  }

  function generateDynamicUnlockToken() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const arr = new Uint8Array(6);
    if (window.crypto && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < 6; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr, b => chars[b % chars.length]).join("");
  }

  async function sha256Hex(str) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }
    return OrbitCompliance.pureJsSha256(unescape(encodeURIComponent(str)));
  }

  async function sha256Buffer(arrayBuffer) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      const buf = await crypto.subtle.digest("SHA-256", arrayBuffer);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }
    const bytes = new Uint8Array(arrayBuffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return OrbitCompliance.pureJsSha256(bin);
  }

  async function verifyProofDocument(file) {
    if (!file || file.size < 4096 || file.size > 5 * 1024 * 1024) {
      return { ok: false, reason: "Proof file must be between 4 KB and 5 MB (blank/tiny files rejected)." };
    }

    const headBuf = await file.slice(0, 8).arrayBuffer();
    const fmt = OrbitCompliance.detectBinaryFormat(new Uint8Array(headBuf));
    if (!fmt) {
      return { ok: false, reason: "Invalid binary magic-byte header (must be authentic PDF, PNG, or JPEG)." };
    }

    if (fmt === "PDF") {
      const sampleHead = new TextDecoder("latin1").decode(await file.slice(0, 32768).arrayBuffer());
      const sampleTail = new TextDecoder("latin1").decode(await file.slice(Math.max(0, file.size - 1024)).arrayBuffer());
      if (!sampleTail.includes("%%EOF") || !sampleHead.includes("obj") || !sampleHead.includes("endobj")) {
        return { ok: false, reason: "Corrupt or empty PDF structure (missing PDF object streams or %%EOF marker)." };
      }
    }

    if (fmt === "PNG" || fmt === "JPEG") {
      const forensicResult = await new Promise(resolve => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          if (img.naturalWidth < 200 || img.naturalHeight < 200) {
            resolve({ ok: false, reason: "Image resolution too low (<200x200px); upload a legible document scan." });
            return;
          }
          try {
            const canvas = document.createElement("canvas");
            canvas.width = 64;
            canvas.height = 64;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, 64, 64);
            const data = ctx.getImageData(0, 0, 64, 64).data;
            let sum = 0;
            let sumSq = 0;
            let count = 0;
            for (let i = 0; i < data.length; i += 4) {
              const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
              sum += lum;
              sumSq += lum * lum;
              count++;
            }
            const mean = sum / count;
            const stdDev = Math.sqrt(Math.max(0, (sumSq / count) - (mean * mean)));
            if (stdDev < 8.0) {
              resolve({ ok: false, reason: "Blank or uniform-color image detected (pixel variance too low to be a real document)." });
              return;
            }
          } catch (e) {}
          resolve({ ok: true });
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          resolve({ ok: false, reason: "Unreadable or corrupted image file." });
        };
        img.src = url;
      });
      if (!forensicResult.ok) return forensicResult;
    }

    const docHash = await sha256Buffer(await file.arrayBuffer());
    return { ok: true, docHash };
  }

  function startOtpTimer() {
    clearInterval(otpCountdown);
    otpSecondsLeft = 60;
    const el = document.getElementById("otpTimer");
    el.textContent = "Expires in 60s";
    otpCountdown = setInterval(() => {
      otpSecondsLeft -= 1;
      if (otpSecondsLeft <= 0) {
        clearInterval(otpCountdown);
        closeModal(document.getElementById("bioModal"));
        document.getElementById("outBox").innerHTML = "<span class='bad'>OTP EXPIRED:</span> 60s window closed. Please retry.";
        syncLockUI();
      } else {
        el.textContent = "Expires in " + otpSecondsLeft + "s";
      }
    }, 1000);
  }

  async function initiateFlow(forceMismatch) {
    const pipeStart = performance.now();
    const out = document.getElementById("outBox");
    if (accountLocked) {
      setStep(1, "Frozen", "bad");
      setStep(3, "Halted", "bad");
      setStep(4, "Halted", "bad");
      syncLockUI();
      out.innerHTML = "<span class='bad'>ACCOUNT LOCKED:</span> Click <strong>Compliance Officer Unlock</strong> and enter the single-use token from Ops Risk Console.";
      addSilentLog("LOCKED ATTEMPT", "Blocked transfer attempt on frozen account");
      return;
    }

    if (forceMismatch) {
      document.getElementById("dep").value = "Unknown Third-Party Sender";
    } else if (document.getElementById("dep").value === "Unknown Third-Party Sender") {
      document.getElementById("dep").value = document.getElementById("kyc").value;
    }

    const kyc = document.getElementById("kyc").value.trim();
    const dep = document.getElementById("dep").value.trim();
    const amt = parseFloat(document.getElementById("amt").value) || 0;
    const rec = document.getElementById("rec").value.trim() || "Recipient";
    const recKey = rec.toLowerCase();
    const purpose = document.getElementById("purpose").value;
    const docType = document.getElementById("docType").value;
    const docNum = document.getElementById("docNum").value.trim().toUpperCase();
    const docFile = document.getElementById("docFile").files[0];
    const c = currentCorridor();
    const m = META[c];
    const r = getActiveRate();

    resetSteps();
    setStep(1, "Parallel Audit...", "run");

    const docCheck = docFile ? await verifyProofDocument(docFile) : { ok: true, docHash: "" };
    if (docFile && !docCheck.ok) {
      setStep(1, "Doc Forensics Failed", "bad");
      out.innerHTML = "<span class='bad'>DOCUMENT FORENSICS FAILED:</span> " + docCheck.reason;
      addSilentLog("SPOOFED FILE BLOCKED", "Rejected '" + docFile.name + "': " + docCheck.reason);
      return;
    }

    const gate = OrbitCompliance.evaluateComplianceGate({
      amount: amt,
      currency: m.from,
      toCurrency: m.to,
      cumulativeInr: cumulativeInrVolume,
      recipientCumulativeInr: recipientVolumes[recKey] || 0,
      kycName: kyc,
      senderName: dep,
      docType,
      docNum,
      hasValidProof: Boolean(docFile && docCheck.ok),
      docHash: docCheck.docHash || "",
      usedDocHashes,
      txHistory,
      rates
    });

    const checkMs = Math.max(4, Math.round(performance.now() - pipeStart));
    document.getElementById("latencyPill").textContent = "Audit Latency: " + checkMs + "ms";

    if (!gate.allowed) {
      if (gate.code === "AML_MISMATCH") {
        setStep(1, "AML BLOCKED", "bad");
        for (let i = 2; i <= 4; i++) setStep(i, "Halted", "bad");
        out.innerHTML = "<span class='bad'>AML BLOCK:</span> " + gate.message;
        addLog("AML BLOCK", amt + " " + m.from + " blocked (mismatched sender)", true);
        addSilentLog("HIGH RISK - AML", "Third-party funding attempt by '" + dep + "' for " + amt + " " + m.from);
        return;
      }
      if (gate.code === "ROUND_TRIP_AML") {
        setStep(1, "Round-Trip AML", "bad");
        for (let i = 2; i <= 4; i++) setStep(i, "Halted", "bad");
        out.innerHTML = "<span class='bad'>CIRCULAR LAYERING BLOCKED:</span> " + gate.message;
        addLog("AML ROUND-TRIP", m.from + "->" + m.to + " blocked (circular flow)", true);
        addSilentLog("BLACK-TO-WHITE LAYERING", "Blocked circular round-trip corridor " + m.from + " -> " + m.to);
        return;
      }
      if (gate.code === "ROLLING_CAP_EXCEEDED") {
        setStep(1, "Rolling Cap Hit", "bad");
        for (let i = 2; i <= 4; i++) setStep(i, "Halted", "bad");
        out.innerHTML = "<span class='bad'>CUMULATIVE LIMIT EXCEEDED:</span> " + gate.message;
        addSilentLog("ANTI-STRUCTURING", "Blocked cumulative volume (> ₹5L rolling cap)");
        return;
      }
      if (gate.code === "DUPLICATE_DOC_HASH") {
        setStep(1, "Duplicate Doc", "bad");
        out.innerHTML = "<span class='bad'>REUSED DOCUMENT BLOCKED:</span> " + gate.message;
        addSilentLog("DOC REUSE FRAUD", "Blocked duplicate proof file SHA-256: " + docCheck.docHash.slice(0, 16));
        return;
      }
      if (gate.code === "INVALID_PAN") {
        setStep(1, "Invalid PAN", "bad");
        out.innerHTML = "<span class='bad'>PAN CHECK FAILED:</span> " + gate.message;
        addSilentLog("KYC MISMATCH", "PAN validation failed (" + docNum + "): " + gate.message);
        return;
      }
      if (gate.code === "PROOF_REQUIRED") {
        setStep(1, "Proof Required", "bad");
        out.innerHTML = "<span class='bad'>PROOF DOCUMENT REQUIRED:</span> " + gate.message;
        addSilentLog("ANTI-STRUCTURING", "Volume crossed ₹2L threshold without verified proof file");
        return;
      }
      setStep(1, "Rule Blocked", "bad");
      out.innerHTML = "<span class='bad'>VALIDATION ERROR:</span> " + gate.message;
      return;
    }

    if (gate.requiresEnhancedDd && docFile) {
      addSilentLog("ENHANCED DUE DILIGENCE", "Cumulative ₹" + formatNum(gate.projected, 0) + " | Doc: " + docType + " (" + docNum + ") | File SHA256: " + docCheck.docHash.slice(0, 12));
    }

    setStep(1, "Verified (" + checkMs + "ms)", "ok");
    setStep(2, "Awaiting OTP", "run");
    pendingTx = {
      kyc, amt, rec, recKey, purpose, docType, docNum, c, m, r,
      inrEquivalent: gate.inrEq,
      docHash: docCheck.docHash || ""
    };

    const code = String(Math.floor(100000 + Math.random() * 900000));
    document.getElementById("liveCode").textContent = code;
    document.getElementById("liveInput").value = "";
    document.getElementById("liveInput").placeholder = "Enter exact 6-digit OTP";
    document.getElementById("modalErr").textContent = "";
    openModal(document.getElementById("bioModal"), document.getElementById("liveInput"));
    startOtpTimer();
  }

  function cancelBio() {
    clearInterval(otpCountdown);
    closeModal(document.getElementById("bioModal"));
    document.getElementById("modalErr").textContent = "";
    syncLockUI();
  }

  function openBankModal() {
    document.getElementById("bankPinInput").value = "";
    document.getElementById("bankErr").textContent = "";
    openModal(document.getElementById("bankModal"), document.getElementById("bankPinInput"));
  }

  function closeBankModal() {
    closeModal(document.getElementById("bankModal"));
    document.getElementById("bankErr").textContent = "";
  }

  function verifyBankUnlock() {
    const pin = document.getElementById("bankPinInput").value.trim().toUpperCase();
    if (!dynamicUnlockToken || pin !== dynamicUnlockToken) {
      document.getElementById("bankErr").textContent = "Invalid single-use token. Check Ops Risk Console for active token.";
      return;
    }
    closeModal(document.getElementById("bankModal"));
    accountLocked = false;
    totalWrongOtpCount = 0;
    dynamicUnlockToken = "";
    saveState(true);
    resetSteps();
    document.getElementById("outBox").innerHTML = "<span class='ok'>COMPLIANCE OFFICER AUTHORIZED:</span> Account unlocked with single-use token.";
    addLog("OFFICER UNLOCK", "Account unlocked via single-use compliance token", false);
    addSilentLog("ACCOUNT UNLOCKED", "Single-use override token consumed & invalidated");
  }

  function copyAuditHash() {
    if (!lastAuditHash) return;
    navigator.clipboard.writeText(lastAuditHash);
    const btn = document.getElementById("copyZkBtn");
    btn.textContent = "Copied Chained Hash!";
    setTimeout(() => { if (btn) btn.textContent = "Copy Chained SHA-256 Receipt"; }, 2000);
  }

  async function completeAfterBio() {
    const expected = document.getElementById("liveCode").textContent.trim();
    const entered = document.getElementById("liveInput").value.trim();
    const out = document.getElementById("outBox");
    const modalErr = document.getElementById("modalErr");

    if (!/^\d{6}$/.test(entered)) {
      modalErr.textContent = "Enter a valid 6-digit OTP. (Fail counter unchanged)";
      document.getElementById("liveInput").focus();
      return;
    }

    if (entered !== expected) {
      totalWrongOtpCount += 1;
      const msg = "Incorrect 6-digit OTP entered.";
      modalErr.textContent = msg;
      document.getElementById("liveInput").focus();
      document.getElementById("liveInput").select();
      addSilentLog("OTP FAILURE (" + totalWrongOtpCount + "/3)", "Wrong 6-digit OTP entered for " + pendingTx.amt + " " + pendingTx.m.from);

      if (totalWrongOtpCount >= 3) {
        clearInterval(otpCountdown);
        accountLocked = true;
        dynamicUnlockToken = generateDynamicUnlockToken();
        saveState(true);
        closeModal(document.getElementById("bioModal"));
        setStep(3, "Halted", "bad");
        setStep(4, "Halted", "bad");
        syncLockUI();
        out.innerHTML = "<span class='bad'>ACCOUNT LOCKED (3/3 WRONG OTP):</span> Single-use unlock token issued to Ops Risk Console.";
        addLog("3x LOCKOUT", "Account frozen after 3 wrong OTPs", true);
        addSilentLog("DYNAMIC UNLOCK TOKEN", "Single-use Compliance Unlock Token generated: " + dynamicUnlockToken);
      } else {
        saveState(true);
        const rem = 3 - totalWrongOtpCount;
        setStep(3, "Halted", "bad");
        setStep(4, "Halted", "bad");
        syncLockUI();
        out.innerHTML = "<span class='bad'>" + msg + " (" + totalWrongOtpCount + "/3):</span> " + rem + " attempt(s) left.";
      }
      return;
    }

    clearInterval(otpCountdown);
    closeModal(document.getElementById("bioModal"));
    modalErr.textContent = "";
    const t0 = performance.now();
    setStep(2, "OTP Verified", "ok");
    setStep(3, "Chaining Hash...", "run");

    const { kyc, amt, rec, recKey, purpose, docType, docNum, c, m, r, inrEquivalent, docHash } = pendingTx;
    const feeRate = getEffectiveFeeRate(c);
    const payout = +(amt * (1 - feeRate) * r).toFixed(2);

    if (payout > pools[m.to]) {
      setStep(3, "Skipped", "wait");
      setStep(4, "Low " + m.to + " Pool", "bad");
      out.innerHTML = "<span class='bad'>LIQUIDITY LIMIT:</span> Requested payout exceeds " + m.to + " local pool balance.";
      addSilentLog("TREASURY HALT", m.to + " pool insufficient for payout of " + payout + " " + m.to);
      return;
    }

    const payload = prevChainHash + "|" + kyc + "|" + amt + "|" + docNum + "|" + c + "|" + sessionNonce + "|" + Date.now();
    const hex = await sha256Hex(payload);
    const shortPrev = prevChainHash.slice(0, 10);
    const currDigest = hex.slice(0, 32);
    lastAuditHash = "sha256:" + currDigest + " (prev:" + shortPrev + ")";
    prevChainHash = currDigest;

    setStep(3, "Chain Linked", "ok");
    setStep(4, "Settling Pool...", "run");

    pools[m.from] += amt;
    pools[m.to] -= payout;
    cumulativeInrVolume += inrEquivalent;
    recipientVolumes[recKey] = (recipientVolumes[recKey] || 0) + inrEquivalent;
    if (docHash) usedDocHashes.push(docHash);
    txHistory.push({ from: m.from, to: m.to, amt, ts: Date.now() });
    saveState(true);

    const elapsed = Math.max(12, Math.round(performance.now() - t0));
    document.getElementById("latencyPill").textContent = "Settle Latency: " + elapsed + "ms";

    const destRatio = pools[m.to] / INIT_POOLS[m.to];
    if (destRatio < 0.20) {
      addSilentLog("TREASURY REBALANCE ALERT", m.to + " pool dropped below 20% reserve (" + (destRatio * 100).toFixed(1) + "%). Dynamic rebalance spread (+0.65%) activated.");
    }

    renderPools();
    refreshQuote();
    setStep(4, "Settled (" + elapsed + "ms)", "ok");

    out.textContent = "";
    const sOk = document.createElement("span");
    sOk.className = "ok";
    sOk.textContent = "SETTLED INSTANTLY in " + elapsed + "ms";
    out.appendChild(sOk);
    out.appendChild(document.createTextNode(" -> " + rec + " (" + purpose + ") | Payout: " + m.sym + formatNum(payout, 2) + " " + m.to + " @ " + r + " (Fee: " + (feeRate * 100).toFixed(2) + "%) | Doc: " + docType));
    out.appendChild(document.createElement("br"));
    const codeEl = document.createElement("code");
    codeEl.textContent = "Chained Receipt: " + lastAuditHash;
    out.appendChild(codeEl);
    out.appendChild(document.createElement("br"));
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.id = "copyZkBtn";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy Chained SHA-256 Receipt";
    copyBtn.onclick = copyAuditHash;
    out.appendChild(copyBtn);

    addLog("SETTLED (" + elapsed + "ms)", amt + " " + m.from + " -> " + m.sym + formatNum(payout, 2) + " " + m.to + " | " + lastAuditHash, false);
  }

  function resetAll() {
    clearInterval(otpCountdown);
    pools = { ...INIT_POOLS };
    totalWrongOtpCount = 0;
    accountLocked = false;
    dynamicUnlockToken = "";
    cumulativeInrVolume = 0;
    recipientVolumes = {};
    usedDocHashes = [];
    txHistory = [];
    prevChainHash = GENESIS_HASH;
    try { sessionStorage.removeItem(STATE_KEY); } catch (e) {}
    broadcastState();
    document.getElementById("dep").value = document.getElementById("kyc").value;
    document.getElementById("docFile").value = "";
    const logList = document.getElementById("logList");
    logList.textContent = "No transactions yet in this session.";
    logList.dataset.empty = "true";
    const stealthLogs = document.getElementById("stealthLogs");
    stealthLogs.textContent = "No risk or treasury events captured yet.";
    stealthLogs.dataset.empty = "true";
    document.getElementById("outBox").innerHTML = "<span class='ok'>RESET COMPLETE:</span> All 4 pools, hash chain, rolling caps, and verification engine restored.";
    resetSteps();
    renderPools();
    refreshQuote();
  }

  const bioModal = document.getElementById("bioModal");
  const bankModal = document.getElementById("bankModal");
  const opsAuthModal = document.getElementById("opsAuthModal");

  bioModal.addEventListener("keydown", e => {
    trapModalTab(bioModal, e);
    if (e.key === "Escape") cancelBio();
  });
  bankModal.addEventListener("keydown", e => {
    trapModalTab(bankModal, e);
    if (e.key === "Escape") closeBankModal();
  });
  opsAuthModal.addEventListener("keydown", e => {
    trapModalTab(opsAuthModal, e);
    if (e.key === "Escape") closeModal(opsAuthModal);
  });

  document.getElementById("orbTrigger").addEventListener("click", toggleStealth);
  document.getElementById("hideConsoleBtn").addEventListener("click", toggleStealth);
  document.getElementById("amt").addEventListener("input", refreshQuote);
  document.getElementById("rec").addEventListener("input", refreshQuote);
  document.getElementById("docType").addEventListener("change", refreshQuote);
  document.getElementById("corridor").addEventListener("change", onCorridorChange);
  document.getElementById("refreshRateBtn").addEventListener("click", () => fetchRates(true));
  document.getElementById("resetDemoBtn").addEventListener("click", resetAll);
  document.getElementById("settleBtn").addEventListener("click", () => initiateFlow(false));
  document.getElementById("amlTestBtn").addEventListener("click", () => initiateFlow(true));
  document.getElementById("bankApproveBtn").addEventListener("click", openBankModal);
  document.getElementById("verifyOtpBtn").addEventListener("click", completeAfterBio);
  document.getElementById("cancelOtpBtn").addEventListener("click", cancelBio);
  document.getElementById("liveInput").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      completeAfterBio();
    }
  });
  document.getElementById("authUnlockBtn").addEventListener("click", verifyBankUnlock);
  document.getElementById("cancelBankBtn").addEventListener("click", closeBankModal);
  document.getElementById("bankPinInput").addEventListener("keydown", e => {
    if (e.key === "Enter") verifyBankUnlock();
  });
  document.getElementById("openOpsBtn").addEventListener("click", verifyOpsAccess);
  document.getElementById("cancelOpsBtn").addEventListener("click", () => closeModal(opsAuthModal));
  document.getElementById("opsPinInput").addEventListener("keydown", e => {
    if (e.key === "Enter") verifyOpsAccess();
  });
  document.addEventListener("keydown", e => {
    if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === "O") {
      e.preventDefault();
      toggleStealth();
    }
  });

  loadState();
  renderPools();
  syncLockUI();
  if (accountLocked) {
    setStep(1, "Frozen", "bad");
    setStep(3, "Halted", "bad");
    setStep(4, "Halted", "bad");
    document.getElementById("outBox").innerHTML = "<span class='bad'>ACCOUNT LOCKED (PERSISTED):</span> Account remains frozen across reload. Click <strong>Compliance Officer Unlock</strong>.";
  }
  refreshQuote();
  fetchRates(false);
})();
