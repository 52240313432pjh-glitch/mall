<!-- Sync Impact Report
Version change: scaffold (unversioned) -> 1.0.0.
Modified principles: scaffold placeholders -> I. Preserve Existing Mall Behavior; II. Product Catalog Is Authoritative; III. Reproducible Retrieval; IV. Safe Service Boundaries; V. Observable Failure.
Added sections: Technology and Data Constraints; Development Workflow.
Removed sections: none (scaffold placeholders were filled).
Follow-up TODOs: none.
Remove this temporary report before committing the constitution.
-->
# Mall Constitution

## Core Principles

### I. Preserve Existing Mall Behavior
New capabilities MUST keep the existing keyword search, product detail, cart, and order flows usable. New APIs MUST use Mall's established response format and MUST not silently change the behavior of existing routes. The reason is that retrieval is an additional way to find products, while commerce remains the system's core function.

### II. Product Catalog Is Authoritative
Retrieval results MUST resolve to published, undeleted products in `pms_product` before being shown to shoppers. Model indexes MAY contain cached identifiers and vectors, but product price, availability, and display data MUST come from the current Mall catalog. This prevents stale or unavailable recommendations from becoming purchasable results.

### III. Reproducible Retrieval
The FashionIQ retrieval path MUST record the source model, prompt, index version, and candidate set. Index creation MUST be repeatable from the recorded catalog and local image files; model weights and large generated vectors MUST remain outside source control. This makes retrieval behavior inspectable and permits deliberate reindexing after catalog changes.

### IV. Safe Service Boundaries
The Python retrieval component MUST expose a bounded request contract and MUST validate image type, image size, text length, category, and result count. The Java portal MUST own the public shopping API and MUST treat the retrieval service as an internal dependency. Secrets and provider endpoints MUST be supplied through environment configuration. This keeps large model processing and provider credentials away from the browser.

### V. Observable Failure
The retrieval service MUST report readiness separately from process liveness and MUST return actionable errors when the index, CLIP weights, or vision provider is unavailable. The portal and frontend MUST present these failures without fabricating results or breaking ordinary product search. This lets operators diagnose an optional model service while shoppers continue to use the store.

## Technology and Data Constraints

The current system uses Spring Boot in `mall-portal`, uni-app/Vue in `mall-app-web`, MySQL for products, and a separate Python runtime for OSCIR FashionIQ retrieval. Integrations MUST keep these boundaries explicit. FashionIQ images are read from the configured local dataset path and mapped to Mall product IDs; application code MUST NOT assume every FashionIQ image has been imported. Model weights, generated indexes, and API keys MUST NOT be committed. Existing MySQL data and Docker volumes MUST be preserved during deployment.

## Development Workflow

For each new feature, define its user-visible behavior, service contract, configuration, and failure behavior before implementation. Review changes against all five principles. When verification is requested or needed for a release, validate both the API contract and the browser flow using the running project; report what was checked and any unavailable dependency. Update the startup guide whenever the running topology or required environment variables change.

## Governance

This constitution governs project-specific design and review decisions. Amendments MUST be documented in this file with a reason and a migration note when existing integrations are affected. A change that removes or redefines a principle requires a major version bump; a new principle or materially expanded requirement requires a minor bump; wording clarifications require a patch bump. Reviewers MUST check new work against the principles and record justified exceptions in the relevant feature plan. The ratification and amendment dates use ISO format.

**Version**: 1.0.0 | **Ratified**: 2026-10-17 | **Last Amended**: 2026-10-17
