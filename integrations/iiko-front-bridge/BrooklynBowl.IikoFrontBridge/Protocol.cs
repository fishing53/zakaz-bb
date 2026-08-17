using System.Collections.Generic;
using Newtonsoft.Json;

namespace BrooklynBowl.IikoFrontBridge
{
    internal sealed class EmployeeDto
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("displayName")] public string DisplayName { get; set; }
        [JsonProperty("firstName")] public string FirstName { get; set; } = "";
        [JsonProperty("middleName")] public string MiddleName { get; set; } = "";
        [JsonProperty("lastName")] public string LastName { get; set; } = "";
        [JsonProperty("roleIds")] public List<string> RoleIds { get; set; } = new List<string>();
        [JsonProperty("roleNames")] public List<string> RoleNames { get; set; } = new List<string>();
        [JsonProperty("isActive")] public bool IsActive { get; set; } = true;
    }

    internal sealed class PairRequest
    {
        public string Code { get; set; }
        public string InstallationId { get; set; }
        public string DisplayName { get; set; }
        public string Version { get; set; }
        public string ApiVersion { get; set; }
        public int ModuleId { get; set; }
        public string TerminalId { get; set; }
    }

    internal sealed class PairResponse
    {
        public string BridgeId { get; set; }
        public string Token { get; set; }
        public string WebsocketUrl { get; set; }
    }
}
