using System;
using Resto.Front.Api;
using Resto.Front.Api.Attributes;
using Resto.Front.Api.Attributes.JetBrains;

namespace BrooklynBowl.IikoFrontBridge
{
    [UsedImplicitly]
    [PluginLicenseModuleId(BuildInfo.LicenseModuleId)]
    public sealed class BridgePlugin : IFrontPlugin
    {
        private readonly BridgeWorker worker;

        public BridgePlugin()
        {
            PluginContext.Log.Info("BrooklynBowl iikoFront Bridge starting");
            worker = new BridgeWorker(BridgeConfig.Load());
            worker.Start();
        }

        public void Dispose()
        {
            worker.Dispose();
            PluginContext.Log.Info("BrooklynBowl iikoFront Bridge stopped");
        }
    }
}
