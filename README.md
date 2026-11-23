# OrbitPay — Cross-Border Liquidity Mesh & Anti-Money Laundering Engine

![OrbitPay CI](https://img.shields.io/badge/Tests-21_Automated_Assertions-22c55e)
![CSP](https://img.shields.io/badge/CSP-Zero_Unsafe--Inline-38bdf8)
![Container](https://img.shields.io/badge/Docker-Non--Root_Nginx_8080-818cf8)

**Track:** PromptWars x Sudarshan (Open Innovation / OrbitPay Challenge)  
**Author:** Ravindra Prajapat (`ravijan2006-create`)

## Problem Statement
Traditional cross-border remittances rely on correspondent banking (SWIFT), causing 3–5 day settlement delays, hidden ~6.5% FX spreads, and fragmented compliance checks. **OrbitPay** replaces slow point-to-point wires with regional liquidity pools (`USD`, `INR`, `EUR`, `GBP`) that settle locally in sub-second latency while enforcing strict anti-money laundering (AML), anti-structuring, forensic document verification, and treasury reserve controls.

## Security, Anti-Laundering & Engineering Architecture
1. **Strict Separation of Concerns & Zero-`unsafe-inline` CSP:**
   - Modular separation across `index.html`, `styles.css`, `compliance.js` (UMD), and `app.js`, enabling a strict `script-src 'self'; style-src 'self';` Content Security Policy in `nginx.conf`.
2. **Multi-Corridor Liquidity Mesh & Parallel FX Circuit Breakers:**
   - Instant local-to-local settlement across 5 corridors (`EUR->INR`, `USD->INR`, `GBP->INR`, `INR->USD`, `USD->EUR`) with dynamic recipient pool routing.
   - Races OpenER-API and Frankfurter in parallel via `Promise.any()` (eliminating sequential timeout lag) and validates quotes against **Circuit Breaker Bounds** (`isRateWithinCircuitBreaker`).
   - Automatically activates a **+0.65% dynamic rebalance spread** when any destination liquidity pool drops below **20% reserve**.
3. **Anti-Money Laundering ("Black-to-White") & Cross-Tab Sync:**
   - **Cross-Tab State Sync (`BroadcastChannel`):** Synchronizes lockouts, pool reserves, and rolling caps across all open browser tabs in real time.
   - **Closed-Loop Sender KYC Match:** Blocks third-party funding attempts where source account holder differs from verified KYC identity.
   - **Sender + Fan-In Recipient Smurfing Protection:** Tracks cumulative rolling volume normalized to INR (`OrbitCompliance.toInr()`) across both sender and recipient (`₹2,00,000` Enhanced Due Diligence threshold; `₹5,00,000` hard rolling cap).
   - **Circular Round-Trip Layering Detection:** Blocks reverse-corridor round-tripping (`INR -> USD` followed by `USD -> INR`) used to launder illicit funds.
4. **Zero-Waste Document Forensics & Deduplication:**
   - Inspects the 8-byte binary header (`%PDF`, `PNG`, `JPEG`) and PDF trailer (`%%EOF`) via `File.slice()` *before* loading full files into memory.
   - Runs Canvas pixel standard-deviation (entropy) analysis to reject blank white/solid-color spoof images and blocks duplicate file SHA-256 reuse.
5. **Tamper-Evident Hash-Chained Audit Ledger & Accessible Modals:**
   - Cryptographically links every settlement digest to the previous block (`prevHash -> currHash`) using Web Crypto SHA-256 with a NIST-verified RFC 6234 pure-JS fallback.
   - Keyboard-accessible modals with focus trapping (`Tab`/`Shift+Tab`) and `Escape` dismissal.

## Evaluator / Judge Testing Guide
- **Sub-Second Settlement:** Keep default inputs (`50 EUR -> INR`, PAN `ABCPP8821F`), click **Verify Document, OTP & Settle**, and enter the displayed 6-digit OTP.
- **Forensic Document & Anti-Structuring Test:** Send `2000 EUR` (~₹2.05L) to trigger mandatory proof upload (`PDF/PNG/JPG >= 4KB` with real visual/text content; blank images or reused files are blocked).
- **Round-Trip AML Test:** Settle `INR -> USD` and then attempt `USD -> INR` to trigger Circular Round-Trip Layering protection.
- **Compliance Ops Risk Console:** Press **`Ctrl + Shift + O`** (or click the top-left OrbitPay button) and enter Evaluator Ops PIN: **`OPS2026`**.

## Automated Tests & Container Deployment
```bash
# Run all 21 shared-module compliance, AML, SHA-256 & forensic unit tests
node test.js

# Build & run hardened non-root Nginx container (Port 8080)
docker build -t orbitpay-mesh .
docker run -p 8080:8080 orbitpay-mesh
```

## Architecture Boundaries & Production Roadmap
- **Client-Side Storage Boundary:** Uses `sessionStorage` + `BroadcastChannel` for zero-friction evaluation; incognito windows or cleared browser storage reset local state (in production, state lives in an immutable server-side PostgreSQL/Kafka ledger).
- **Document Verification Boundary:** Performs binary header, PDF structure, pixel entropy, and SHA-256 deduplication checks client-side; production integrates server-side NSDL/DigiLocker OCR verification.
- **Settlement Rails Boundary:** Simulates regional liquidity pools in memory; production connects to licensed RBI AD-I / FinCEN MTL banking rails with forward FX hedging.
