# Security Policy

## Scope

This repository contains the source code for the MapleStory MVP Detector — a client-side web application that runs entirely in the browser. It has no backend, no user accounts, no server-side data collection, and no cookies. All processing (OCR, image analysis) happens locally via Web Workers and WASM.

The landing page at [ms-mvp.com](https://ms-mvp.com) has its own [security policy](https://github.com/NecturaLabs/MapleStory-MVP-Detector-Website/security/policy).

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Use [GitHub private vulnerability reporting](https://github.com/NecturaLabs/MapleStory-MVP-Detector/security/advisories/new) to report issues confidentially. We will respond within 7 days.

## What to Report

- Secrets or credentials accidentally committed to the repository
- Supply chain issues in CI/CD workflows (e.g. compromised GitHub Actions)
- XSS or content injection via user-supplied input (e.g. chat text parsing)
- Subresource integrity issues with third-party scripts or WASM modules
- Data exfiltration from the browser (e.g. screen capture data leaking)

## Out of Scope

- Issues in Netlify's infrastructure (report to Netlify)
- Issues in the landing page site (report to [that repo](https://github.com/NecturaLabs/MapleStory-MVP-Detector-Website/security/advisories/new))
- Social engineering attempts
- Browser-level vulnerabilities (report to the browser vendor)
