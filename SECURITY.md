# Security Policy

## What this repo contains

This repository contains **the copilot's core**: the plan schema, the validator
that enforces it, the tool-calling loop, and the no-fakes guard.

It contains **no credentials and no data**. Every secret is read from the
environment at runtime; nothing sensitive is committed. See
[`.gitignore`](.gitignore).

## The data path, and where a brand's data goes

A brand's Meta/Instagram performance and a creator's audience signals are read
through the Meta Graph API and the Instagram Platform, and are placed in the
model request for the plan. Two properties of that path are deliberate:

1. **Zero data retention.** Baseten applies zero data retention to synchronous
   Model API requests, so a brand's real metrics are not kept in an inference
   log.
2. **No number is published without a row.** Every metric in a generated plan
   carries a `sourceRowId`, and the validator rejects any plan that cites a row
   that does not exist. The guard in `src/agent/no-fakes.ts` additionally
   rejects a plan whose cited value disagrees with the row's own value.

## Reporting a vulnerability

Open a GitHub issue on this repository. Please do not include a live token, a
real brand's metrics, or a real creator's personal data in the report — a
synthetic reproduction is enough and is safer for everyone.
