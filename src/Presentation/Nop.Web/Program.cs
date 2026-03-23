using Autofac.Extensions.DependencyInjection;
using Nop.Core.Configuration;
using Nop.Core.Infrastructure;
using Nop.Core.Telemetry;
using Nop.Web.Framework.Infrastructure.Extensions;
using Nop.Web.Infrastructure;
using OpenFeature;
using OpenFeature.Contrib.Providers.Flagd;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Nop.Web;

public partial class Program
{
    public static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Configuration.AddJsonFile(NopConfigurationDefaults.AppSettingsFilePath, true, true);
        if (!string.IsNullOrEmpty(builder.Environment?.EnvironmentName))
        {
            var path = string.Format(NopConfigurationDefaults.AppSettingsEnvironmentFilePath, builder.Environment.EnvironmentName);
            builder.Configuration.AddJsonFile(path, true, true);
        }
        builder.Configuration.AddEnvironmentVariables();

        //load application settings
        builder.Services.ConfigureApplicationSettings(builder);

        var appSettings = Singleton<AppSettings>.Instance;
        var useAutofac = appSettings.Get<CommonConfig>().UseAutofac;

        if (useAutofac)
            builder.Host.UseServiceProviderFactory(new AutofacServiceProviderFactory());
        else
        {
            builder.Host.UseDefaultServiceProvider(options =>
            {
                //we don't validate the scopes, since at the app start and the initial configuration we need 
                //to resolve some services (registered as "scoped") through the root container
                options.ValidateScopes = false;
                options.ValidateOnBuild = true;
            });
        }

        //add services to the application and configure service provider
        builder.Services.ConfigureApplicationServices(builder);

        builder.Services.AddOpenTelemetry()
            .ConfigureResource(resource => resource
                .AddService(
                    serviceName: NopTelemetry.ServiceName,
                    serviceVersion: typeof(Program).Assembly.GetName().Version?.ToString()))
            .WithTracing(tracing => tracing
                .AddSource(NopTelemetry.ActivitySource.Name)
                .AddAspNetCoreInstrumentation(options =>
                {
                    options.RecordException = true;
                })
                .AddHttpClientInstrumentation()
                .AddProcessor(new TelemetrySanitizingProcessor())
                .AddOtlpExporter())
            .WithMetrics(metrics => metrics
                .AddMeter(NopTelemetry.Meter.Name)
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddRuntimeInstrumentation()
                .AddOtlpExporter());

        var app = builder.Build();

        // Initialise OpenFeature with the FlagD provider.
        // FlagD runs as a sidecar (see docker-compose.yml) and hot-reloads
        // flagd/flags.json — no app restart needed to toggle flags.
        // If FlagD is unavailable the SDK falls back to the default value
        // passed at each evaluation call, so startup is never blocked.
        var flagdHost = builder.Configuration["FLAGD_HOST"] ?? "flagd";
        var flagdPort = builder.Configuration["FLAGD_PORT"] ?? "8013";
        await Api.Instance.SetProviderAsync(
            new FlagdProvider(new Uri($"http://{flagdHost}:{flagdPort}")));

        //configure the application HTTP request pipeline
        app.ConfigureRequestPipeline();
        await app.PublishAppStartedEventAsync();

        await app.RunAsync();
    }
}
