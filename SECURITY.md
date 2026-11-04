# Security and public data boundary

This repository is a public demonstration of AI Creator and brand campaign planning functionality from the justnewme.com project. The tracked fixtures are synthetic. The public demo does not connect to the production marketplace or include its credentials or customer data.

API keys are read from environment variables at runtime. Do not commit `.env` files, keys, creator voice memos, real metrics, customer records, or production exports. Review new fixtures and transcripts before publishing them. A `.gitignore` rule alone does not remove a file that was already committed.

The validators check model output against the rows supplied to them. An integrator is responsible for authentication, consent, access control, data retention, and secure handling of any real rows or audio passed into the modules. The default web demo uses synthetic rows and a scripted model when no model key is configured.

To report a vulnerability, use GitHub's private vulnerability reporting for this repository if enabled. Otherwise, contact the repository owner through a private channel. Do not put live tokens or personal data in a public issue; use a synthetic reproduction.
