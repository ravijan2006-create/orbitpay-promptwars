(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.OrbitCompliance = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  const DEFAULT_RATES = Object.freeze({
    EUR_INR: 102.523,
    USD_INR: 93.3727,
    GBP_INR: 118.2,
    INR_USD: 0.01071,
    USD_EUR: 0.9107
  });

  const RATE_BOUNDS = Object.freeze({
    EUR_INR: [75, 140],
    USD_INR: [70, 125],
    GBP_INR: [90, 160],
    INR_USD: [0.008, 0.015],
    USD_EUR: [0.65, 1.25]
  });

  function isRateWithinCircuitBreaker(corridor, rate) {
    const num = Number(rate);
    if (!Number.isFinite(num) || num <= 0) return false;
    const bounds = RATE_BOUNDS[corridor];
    if (!bounds) return true;
    return num >= bounds[0] && num <= bounds[1];
  }

  function toInr(amount, currency, rates = DEFAULT_RATES) {
    if (currency === "INR") return amount;
    if (currency === "USD") return amount * rates.USD_INR;
    if (currency === "EUR") return amount * rates.EUR_INR;
    if (currency === "GBP") return amount * rates.GBP_INR;
    return amount * rates.USD_INR;
  }

  function validatePanForHolder(pan, fullName) {
    const cleanPan = String(pan || "").trim().toUpperCase();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cleanPan)) {
      return "PAN must follow 10-char format (e.g. ABCPP8821F).";
    }
    if (cleanPan[3] !== "P") {
      return "4th character of individual PAN must be 'P' (Personal).";
    }
    const parts = String(fullName || "").trim().toUpperCase().split(/\s+/).filter(Boolean);
    const surnameInitial = parts.length > 0 ? parts[parts.length - 1][0] : "";
    if (surnameInitial && cleanPan[4] !== surnameInitial) {
      return "5th character of PAN must match holder surname initial ('" + surnameInitial + "').";
    }
    return "";
  }

  function detectCircularRoundTrip(history, fromCurrency, toCurrency) {
    if (!Array.isArray(history) || history.length === 0) return false;
    return history.some(tx => tx.from === toCurrency && tx.to === fromCurrency);
  }

  function detectBinaryFormat(headerBytes) {
    if (!headerBytes || headerBytes.length < 4) return null;
    if (headerBytes[0] === 0x25 && headerBytes[1] === 0x50 && headerBytes[2] === 0x44 && headerBytes[3] === 0x46) {
      return "PDF";
    }
    if (headerBytes[0] === 0x89 && headerBytes[1] === 0x50 && headerBytes[2] === 0x4E && headerBytes[3] === 0x47) {
      return "PNG";
    }
    if (headerBytes[0] === 0xFF && headerBytes[1] === 0xD8 && headerBytes[2] === 0xFF) {
      return "JPEG";
    }
    return null;
  }

  function pureJsSha256(ascii) {
    const rightRotate = (v, a) => (v >>> a) | (v << (32 - a));
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    let result = "";
    const words = [];
    const asciiBitLength = ascii.length * 8;
    const hash = [];
    const k = [];
    let primeCounter = 0;
    const isComposite = {};

    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }

    ascii += "\x80";
    while (ascii.length % 64 - 56) ascii += "\x00";
    for (let i = 0; i < ascii.length; i++) {
      const j = ascii.charCodeAt(i);
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;

    for (let j = 0; j < words.length;) {
      const w = words.slice(j, j += 16);
      const oldHash = hash.slice(0);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15];
        const w2 = w[i - 2];
        const a = hash[0];
        const e = hash[4];
        const temp1 = hash[7] +
          (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
          ((e & hash[5]) ^ ((~e) & hash[6])) +
          k[i] +
          (w[i] = i < 16
            ? w[i]
            : (w[i - 16] + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) | 0);
        const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash.unshift((temp1 + temp2) | 0);
        hash[4] = (hash[4] + temp1) | 0;
        hash.pop();
      }
      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }

    for (let i = 0; i < 8; i++) {
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? "0" : "") + b.toString(16);
      }
    }
    return result;
  }

  function evaluateComplianceGate({
    amount,
    currency,
    toCurrency,
    cumulativeInr,
    recipientCumulativeInr = 0,
    kycName,
    senderName,
    docType,
    docNum,
    hasValidProof,
    docHash = "",
    usedDocHashes = [],
    txHistory = [],
    rates = DEFAULT_RATES
  }) {
    if (!amount || amount <= 0 || !Number.isFinite(amount)) {
      return { allowed: false, code: "INVALID_AMOUNT", message: "Enter a positive transfer amount." };
    }
    if (!kycName || !senderName || kycName.trim().toLowerCase() !== senderName.trim().toLowerCase()) {
      return { allowed: false, code: "AML_MISMATCH", message: "Source bank holder does not match verified KYC holder (Third-party funding blocked)." };
    }
    if (toCurrency && detectCircularRoundTrip(txHistory, currency, toCurrency)) {
      return { allowed: false, code: "ROUND_TRIP_AML", message: "Circular round-trip layering detected (" + currency + " <-> " + toCurrency + "). Transfer frozen for AML review." };
    }

    const inrEq = toInr(amount, currency, rates);
    const projectedSender = cumulativeInr + inrEq;
    const projectedRecipient = recipientCumulativeInr + inrEq;

    if (projectedSender > 500000 || projectedRecipient > 500000) {
      return { allowed: false, code: "ROLLING_CAP_EXCEEDED", message: "Rolling sender/recipient volume exceeds ₹5,00,000 hard cap (Anti-structuring protection)." };
    }

    if (docType === "PAN Card") {
      const panErr = validatePanForHolder(docNum, kycName);
      if (panErr) return { allowed: false, code: "INVALID_PAN", message: panErr };
    } else if (!docNum || String(docNum).trim().length < 6) {
      return { allowed: false, code: "DOC_ID_REQUIRED", message: "Enter a valid Document ID number (min 6 chars)." };
    }

    if (docHash && Array.isArray(usedDocHashes) && usedDocHashes.includes(docHash)) {
      return { allowed: false, code: "DUPLICATE_DOC_HASH", message: "Duplicate proof document detected. Reusing the same invoice/ID file across transfers is blocked." };
    }

    const requiresEnhancedDd = projectedSender > 200000 || projectedRecipient > 200000;
    if (requiresEnhancedDd && !hasValidProof) {
      return { allowed: false, code: "PROOF_REQUIRED", message: "Cumulative sender/recipient volume exceeds ₹2,00,000. Upload a genuine non-blank PDF/JPG/PNG proof document." };
    }

    return {
      allowed: true,
      code: "APPROVED",
      inrEq,
      projected: projectedSender,
      projectedRecipient,
      requiresEnhancedDd
    };
  }

  return Object.freeze({
    DEFAULT_RATES,
    RATE_BOUNDS,
    isRateWithinCircuitBreaker,
    toInr,
    validatePanForHolder,
    detectCircularRoundTrip,
    detectBinaryFormat,
    pureJsSha256,
    evaluateComplianceGate
  });
}));
