using System;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;

namespace BrooklynBowl.IikoFrontBridge
{
    internal sealed class BridgeConfig
    {
        public string ServerUrl { get; set; } = "https://заказ.звяк.рф";
        public string PairingCode { get; set; } = "";
        public string DisplayName { get; set; } = "BrooklynBowl iikoFront";

        public static BridgeConfig Load()
        {
            var path = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? "", "BridgeConfig.json");
            if (!File.Exists(path)) return new BridgeConfig();
            return JsonConvert.DeserializeObject<BridgeConfig>(File.ReadAllText(path, Encoding.UTF8)) ?? new BridgeConfig();
        }
    }

    internal sealed class BridgeCredential
    {
        public string BridgeId { get; set; }
        public string Token { get; set; }
        public string WebsocketUrl { get; set; }
    }

    internal static class CredentialStore
    {
        private static readonly string DirectoryPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "BrooklynBowl", "IikoFrontBridge");
        private static readonly string FilePath = Path.Combine(DirectoryPath, "credential.bin");

        public static BridgeCredential Load()
        {
            if (!File.Exists(FilePath)) return null;
            var clear = ProtectedData.Unprotect(File.ReadAllBytes(FilePath), null, DataProtectionScope.LocalMachine);
            return JsonConvert.DeserializeObject<BridgeCredential>(Encoding.UTF8.GetString(clear));
        }

        public static void Save(BridgeCredential value)
        {
            Directory.CreateDirectory(DirectoryPath);
            var clear = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(value));
            File.WriteAllBytes(FilePath, ProtectedData.Protect(clear, null, DataProtectionScope.LocalMachine));
        }
    }
}
