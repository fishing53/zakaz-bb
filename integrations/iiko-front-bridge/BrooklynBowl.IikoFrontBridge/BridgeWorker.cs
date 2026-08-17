using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Resto.Front.Api;
using Resto.Front.Api.Data.Security;

namespace BrooklynBowl.IikoFrontBridge
{
    internal sealed class BridgeWorker : IDisposable
    {
        private readonly BridgeConfig config;
        private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        private readonly SemaphoreSlim sendLock = new SemaphoreSlim(1, 1);
        private Task loop;

        public BridgeWorker(BridgeConfig config) { this.config = config; }
        public void Start() { loop = Task.Run(() => RunAsync(cancellation.Token)); }

        private async Task RunAsync(CancellationToken token)
        {
            var delaySeconds = 2;
            while (!token.IsCancellationRequested)
            {
                try
                {
                    var credential = CredentialStore.Load() ?? await PairAsync(token).ConfigureAwait(false);
                    await ConnectAsync(credential, token).ConfigureAwait(false);
                    delaySeconds = 2;
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                catch (Exception error)
                {
                    PluginContext.Log.Warn("iikoFront Bridge connection failed: " + error.Message);
                    await Task.Delay(TimeSpan.FromSeconds(delaySeconds), token).ConfigureAwait(false);
                    delaySeconds = Math.Min(delaySeconds * 2, 60);
                }
            }
        }

        private async Task<BridgeCredential> PairAsync(CancellationToken token)
        {
            if (string.IsNullOrWhiteSpace(config.PairingCode)) throw new InvalidOperationException("Bridge is not paired. Add PairingCode to BridgeConfig.json.");
            var terminal = PluginContext.Operations.GetHostTerminal();
            var installationId = PluginContext.Operations.GetOrganizationFingerprint() + "-" + terminal.Id.ToString("N");
            var request = new PairRequest {
                Code = config.PairingCode, InstallationId = installationId, DisplayName = config.DisplayName,
                Version = Assembly.GetExecutingAssembly().GetName().Version.ToString(), ApiVersion = "V8",
                ModuleId = BuildInfo.LicenseModuleId, TerminalId = terminal.Id.ToString()
            };
            using (var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) })
            using (var content = new StringContent(JsonConvert.SerializeObject(request), Encoding.UTF8, "application/json"))
            using (var response = await client.PostAsync(config.ServerUrl.TrimEnd('/') + "/api/v1/iiko-front/pair", content, token).ConfigureAwait(false))
            {
                var json = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Pairing rejected by server: " + (int)response.StatusCode);
                var result = JsonConvert.DeserializeObject<PairResponse>(json) ?? throw new InvalidOperationException("Empty pairing response");
                var credential = new BridgeCredential { BridgeId = result.BridgeId, Token = result.Token, WebsocketUrl = result.WebsocketUrl };
                CredentialStore.Save(credential);
                return credential;
            }
        }

        private async Task ConnectAsync(BridgeCredential credential, CancellationToken token)
        {
            using (var socket = new ClientWebSocket())
            {
                socket.Options.SetRequestHeader("Authorization", "Bearer " + credential.Token);
                socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                await socket.ConnectAsync(new Uri(credential.WebsocketUrl), token).ConfigureAwait(false);
                var terminal = PluginContext.Operations.GetHostTerminal();
                await SendAsync(socket, new { type = "hello", displayName = config.DisplayName, version = Assembly.GetExecutingAssembly().GetName().Version.ToString(), apiVersion = "V8", moduleId = BuildInfo.LicenseModuleId, terminalId = terminal.Id.ToString() }, token).ConfigureAwait(false);
                await SendEmployeesAsync(socket, token).ConfigureAwait(false);
                using (var connectionCancellation = CancellationTokenSource.CreateLinkedTokenSource(token))
                {
                    var heartbeat = HeartbeatAsync(socket, connectionCancellation.Token);
                    var employeeSync = EmployeeSyncAsync(socket, connectionCancellation.Token);
                    try { await ReceiveAsync(socket, connectionCancellation.Token).ConfigureAwait(false); }
                    finally { connectionCancellation.Cancel(); }
                    try { await Task.WhenAll(heartbeat, employeeSync).ConfigureAwait(false); }
                    catch (OperationCanceledException) when (!token.IsCancellationRequested) { }
                }
            }
        }

        private async Task ReceiveAsync(ClientWebSocket socket, CancellationToken token)
        {
            var buffer = new byte[64 * 1024];
            while (socket.State == WebSocketState.Open && !token.IsCancellationRequested)
            {
                using (var stream = new System.IO.MemoryStream())
                {
                    WebSocketReceiveResult result;
                    do {
                        result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), token).ConfigureAwait(false);
                        if (result.MessageType == WebSocketMessageType.Close) return;
                        stream.Write(buffer, 0, result.Count);
                        if (stream.Length > 2 * 1024 * 1024) throw new InvalidOperationException("Server message is too large");
                    } while (!result.EndOfMessage);
                    var message = JObject.Parse(Encoding.UTF8.GetString(stream.ToArray()));
                    var type = (string)message["type"];
                    if (type == "auth_request") await AuthenticateAsync(socket, (string)message["requestId"], (string)message["pin"], token).ConfigureAwait(false);
                    else if (type == "sync_employees") await SendEmployeesAsync(socket, token).ConfigureAwait(false);
                }
            }
        }

        private async Task AuthenticateAsync(ClientWebSocket socket, string requestId, string pin, CancellationToken token)
        {
            try
            {
                var credentials = PluginContext.Operations.AuthenticateByPin(pin);
                var user = PluginContext.Operations.GetUser(credentials);
                await SendAsync(socket, new { type = "auth_result", requestId, ok = true, employee = ToEmployee(user) }, token).ConfigureAwait(false);
            }
            catch
            {
                await SendAsync(socket, new { type = "auth_result", requestId, ok = false, error = "Неверный PIN-код" }, token).ConfigureAwait(false);
            }
        }

        private async Task SendEmployeesAsync(ClientWebSocket socket, CancellationToken token)
        {
            var employees = new List<EmployeeDto>();
            foreach (var user in PluginContext.Operations.GetUsers(false).Where(user => user.AssignedToCurrentDepartment && (user.Type & UserType.Employee) == UserType.Employee))
            {
                try { employees.Add(ToEmployee(user)); }
                catch (Exception error) { PluginContext.Log.Warn("Unable to read iiko employee " + user.Id + ": " + error.Message); }
            }
            await SendAsync(socket, new { type = "employees_snapshot", snapshotId = Guid.NewGuid().ToString("N"), employees }, token).ConfigureAwait(false);
        }

        private async Task EmployeeSyncAsync(ClientWebSocket socket, CancellationToken token)
        {
            while (socket.State == WebSocketState.Open && !token.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromMinutes(10), token).ConfigureAwait(false);
                if (socket.State == WebSocketState.Open) await SendEmployeesAsync(socket, token).ConfigureAwait(false);
            }
        }

        private static EmployeeDto ToEmployee(IUser user)
        {
            var roles = PluginContext.Operations.GetUserRoles(user);
            return new EmployeeDto {
                Id = user.Id.ToString(), DisplayName = user.Name,
                RoleIds = roles.Select(role => role.Id.ToString()).ToList(),
                RoleNames = roles.Select(role => role.Name).ToList(), IsActive = true
            };
        }

        private async Task HeartbeatAsync(ClientWebSocket socket, CancellationToken token)
        {
            while (socket.State == WebSocketState.Open && !token.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(20), token).ConfigureAwait(false);
                await SendAsync(socket, new { type = "heartbeat" }, token).ConfigureAwait(false);
            }
        }

        private async Task SendAsync(ClientWebSocket socket, object value, CancellationToken token)
        {
            var bytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(value));
            await sendLock.WaitAsync(token).ConfigureAwait(false);
            try { await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token).ConfigureAwait(false); }
            finally { sendLock.Release(); }
        }

        public void Dispose()
        {
            cancellation.Cancel();
            try { loop?.Wait(TimeSpan.FromSeconds(5)); } catch { }
            sendLock.Dispose(); cancellation.Dispose();
        }
    }
}
