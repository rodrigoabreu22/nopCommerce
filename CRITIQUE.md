# Critique: Observability in nopCommerce

nopCommerce's layered architecture made instrumentation easier than it could have been, and harder than it should be. The design reflects a pre-observability era: built for features and functional correctness, not for production insight.

## What Helped

The narrowness of `IOrderProcessingService.PlaceOrderAsync` was the single biggest advantage. Every order, regardless of payment method, cart size, or customer type, flows through one method. One span at its entry gives you the entire service-layer latency of a checkout. Two child spans (`checkout.payment.process`, `checkout.order.save`) give latency attribution without touching any other class. That is an architectural benefit: a single orchestration method rather than distributed choreography across services.

The DI-managed boundaries and zero-dependency `Nop.Core` layer made cross-cutting telemetry easy to add without modifying service constructors. Telemetry is infrastructure, and `Nop.Core` is the right place for it.

## What Hindered

The service locator (`EngineContext.Current.ResolveAll`) inside `EventPublisher` is the main structural obstacle. Consumer spans cannot be children of the publishing span because consumers are instantiated through a global static, bypassing the DI scope that carries trace context. This makes the event fan-out opaque: 114 cache consumers run sequentially on the request thread, and any slow one is invisible in the trace.

The payment plugin system compounds this. `ProcessPaymentAsync` is called on a runtime-loaded plugin assembly with no instrumentation contract. The span boundary sits at the service layer and timing is captured, but any internal work the plugin does is a black box.

## Architectural Changes Going Forward

The highest-value low-cost change is an `IEventPublisher` decorator: one class, one DI override, full event-level trace coverage without touching any consumer. The second is a repository-level timing decorator on `IRepository<T>`, which would answer "how much of checkout time is database time?" across the entire application at once.

The service locator is the deeper problem. Migrating `EventPublisher` to constructor-injected `IEnumerable<IConsumer<TEvent>>` would let trace context propagate naturally through the consumer call stack. It is a single-file change but a behavioral one. This is, the consumer construction moves from per-call to per-startup, and it is better justified as part of a broader testability investment than as a pure observability fix.

There is also a resilience gap this assignment exposed directly. When the database was stopped during load testing to simulate system failures, the ASP.NET Core application failed entirely before any instrumented code ran: no degraded response, just a crash at the landing page. This made infrastructure-fault testing impossible. The solution was a feature flag (OpenFeature + FlagD) that injects payment failures at the service layer at runtime. That the flag was necessary at all is an architectural observation: there is no circuit-breaker, no graceful degradation path, and no health-check-gated fallback between the web tier and the database. The web and database are effectively a single unit of failure.

## Surgical Changes and Why They Were Minimal

Four files were modified. `NopTelemetry.cs` was added to `Nop.Core` — a static class holding the `ActivitySource`, `Meter`, and all counters and histograms. Placing it in `Nop.Core` means every layer can reference it without introducing a new dependency direction. The alternative was constructor-injected telemetry, which would have required changing every service constructor, which is the opposite of surgical.

`OrderProcessingService.PlaceOrderAsync` received three child spans. `ShoppingCartService.AddToCartAsync` received one. `CheckoutController` received the HTTP entry-point spans that parent everything. 