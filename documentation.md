# AS - Assignment 1: Architecture Analysis

---

## 1. Layer Organization & Dependency Rules
The nopCommerce architecture follows a strict **N-Layered** approach with a clear dependency flow to ensure separation of concerns.

### Layer Breakdown
* **Core (`src/Libraries/Nop.Core`)**
    * **Role:** Defines domain entities, shared abstractions, and base infrastructure (DI engine, type finder, event contracts).
    * **Key Components:** `IEngine`, `EngineContext`, `INopStartup`, and event contracts.
    * **Dependencies:** None. This is the base layer.
* **Data (`src/Libraries/Nop.Data`)**
    * **Role:** Handles data access, the repository pattern, and data providers.
    * **Key Components:** `EntityRepository` (the main write boundary).
    * **Dependencies:** `Nop.Core` only.
* **Services (`src/Libraries/Nop.Services`)**
    * **Role:** Contains business logic and orchestration. This is where most domain behavior and instrumentation potential reside.
    * **Dependencies:** `Nop.Core` and `Nop.Data`.
* **Presentation (`src/Presentation/Nop.Web` & `Nop.Web.Framework`)**
    * **Role:** MVC/UI, middleware, DI registration, and web endpoints. 
    * **Dependencies:** `Nop.Core`, `Nop.Data`, `Nop.Services`, and `Web.Framework`.
* **Plugins (`src/Plugins`)**
    * **Role:** Extension points integrated via runtime discovery using `ITypeFinder`.
    * **Dependencies:** Can depend on `Nop.Core` and `Nop.Services`.

### Dependency Rules Summary
| Project | Depends On |
| :--- | :--- |
| **Nop.Core** | None (Base Layer) |
| **Nop.Data** | Core |
| **Nop.Services** | Core + Data |
| **Nop.Web** | Core + Data + Services + Web.Framework |

---

## 2. Internal Event Handling (`IEventPublisher`)
nopCommerce utilizes an in-process event system to decouple components and handle cross-cutting concerns like caching.

### How Events Work Internally
1.  **Contract:** `IEventPublisher` (in Core) defines the publish API.
2.  **Implementation:** `EventPublisher` (in Services) pulls all `IConsumer<TEvent>` implementations from the container and calls them sequentially.
3.  **Service Locator:** It uses `EngineContext.Current.ResolveAll<IConsumer<TEvent>>()` to find consumers at runtime.
4.  **Short-Circuiting:** If an event implements `IStopProcessingEvent` and `StopProcessing` is set to true, further consumers are skipped.

### Common Event Types
* **Entity Lifecycle:** Produced via extensions in Core and emitted by the Data layer (e.g., `InsertAsync`, `UpdateAsync`, `DeleteAsync`).
* **Domain-Specific:** Custom events like `GetShoppingCartItemUnitPriceEvent`.
* **Consumers:** Implement `IConsumer<T>` (e.g., `CacheEventConsumer` listens for entity changes to invalidate cache entries).

> **Implication:** The system is **synchronous and in-process**. While this provides a strong observability boundary, it can become a latency hotspot because publishing awaits all consumers in order.

---

## 3. Observability: Ease vs. Difficulty

### Where Observability is Easy
* **Service Layer:** Most services are resolved via DI, making them candidates for decoration or cross-cutting behaviors in `NopStartup`.
* **Repository Boundary:** `EntityRepository` centralizes data writes, making it a high-value point for timing and data-change metrics.
* **Event Publishing:** `IEventPublisher` is a clean "seam" where a single decorator can add metrics/tracing for all events.
* **Request Pipeline:** Middleware in `INopStartup` allows for consistent per-request tracing and correlation.

### Where Observability is Hard
* **Service Locator Usage:** Frequent use of `EngineContext.Current.Resolve` bypasses constructor injection, obscuring dependencies and making context/trace propagation difficult.
* **Synchronous Events:** Because processing is sequential, telemetry overhead directly impacts user request latency.
* **Lack of Cross-Cutting Context:** There is no native `OpenTelemetry` or `Activity` context; correlation IDs must be manually threaded through the stack.
* **Manual DI Registration:** The large, manual DI graph makes adding decorators across many services noisy and prone to human error.

---

## 4. Proposed Structural Changes

### Required Changes for "Proper" Instrumentation
1.  **Instrumentation Abstraction:** Introduce `IInstrumentation` or `ITracingContext` in `Nop.Core` to be injected into services.
2.  **Eliminate Service Locators:** Refactor `EventPublisher` and `CacheEventConsumer` to use **Constructor Injection**. This allows tracers to be injected cleanly.
3.  **Trace-Aware Middleware:** Add middleware in the Presentation layer to create a request-scoped span and flow it into Services/Data.
4.  **DI Decorators:** Use decorators for `IEventPublisher` and `IRepository<>` to collect consistent telemetry without modifying every individual service implementation.

### Is the change worth it?
* **YES:** If you require production-grade, end-to-end tracing and reliable cross-layer metrics with low manual instrumentation.
* **NO:** If "good enough" visibility (basic timings and counts) is the goal. You can get high leverage by simply decorating `IEventPublisher` and targeting critical services like Orders or Payments for explicit spans.

---

## 5. Local Observability Stack (Docker Compose)

### What was added
The project now includes a minimal local observability stack:
* **OpenTelemetry Collector** (receives OTLP from nopCommerce)
* **Jaeger** (trace UI)
* **Prometheus** (metrics store)
* **Grafana** (dashboards)

### How to run
From the project root:
```bash
docker compose build
docker compose up
```

### Endpoints
* nopCommerce: `http://localhost:80`
* Jaeger UI (traces): `http://localhost:16686`
* Prometheus: `http://localhost:9090`
* Grafana: `http://localhost:3000` (default login `admin` / `admin`)

### Notes
* OTLP export is configured via environment variables in `docker-compose.yml` under `nopcommerce_web`.
* The collector config lives in `otel-collector-config.yml`.
* Prometheus scrape config lives in `prometheus.yml`.
