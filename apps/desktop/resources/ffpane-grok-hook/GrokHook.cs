// Grok 钩子程序（T10.18）。Grok 只启动这一个 exe，不带参数。
// 事件来自环境变量 GROK_HOOK_EVENT、GROK_SESSION_ID，以及标准输入上的 JSON。
// 管道名和窗口令牌从本进程继承的环境读取，不写进钩子文件。
// 退出码恒为 0，避免 Stop 把这一轮拦住。

using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

internal static class GrokHook
{
    private static int Main()
    {
        try
        {
            Report();
        }
        catch
        {
            // 失败也正常结束，避免卡住 Grok。
        }
        return 0;
    }

    private static void Report()
    {
        var rawEvent = Environment.GetEnvironmentVariable("GROK_HOOK_EVENT") ?? "";
        var sessionId = Environment.GetEnvironmentVariable("GROK_SESSION_ID") ?? "";
        var pipePath = Environment.GetEnvironmentVariable("FF_PANE_WB_PIPE") ?? "";
        var token = Environment.GetEnvironmentVariable("FF_PANE_WINDOW_TOKEN") ?? "";
        var stdin = ReadStdin();
        if (sessionId.Length == 0)
        {
            sessionId = JsonString(stdin, "sessionId");
        }
        var toolUseId = JsonString(stdin, "toolUseId");
        if (toolUseId.Length == 0)
        {
            toolUseId = JsonString(stdin, "tool_use_id");
        }
        var notification = JsonString(stdin, "notificationType");
        var reason = JsonString(stdin, "reason");
        var mapped = Map(rawEvent, notification);
        if (mapped.Length == 0 || pipePath.Length == 0 || token.Length == 0)
        {
            return;
        }
        var release =
            rawEvent == "stop_cancelled" &&
            (reason == "permission_rejected" || reason == "permission_cancelled");
        Send(pipePath, token, mapped, notification, toolUseId, sessionId, release);
    }

    private static string Map(string rawEvent, string notification)
    {
        if (rawEvent == "stop") return "Stop";
        if (rawEvent == "stop_failure") return "StopFailure";
        if (rawEvent == "stop_cancelled") return "StopCancelled";
        if (rawEvent == "permission_denied") return "PermissionDenied";
        if (rawEvent == "post_tool_use") return "PostToolUse";
        if (rawEvent == "post_tool_use_failure") return "PostToolUseFailure";
        if (rawEvent == "user_prompt_submit") return "UserPromptSubmit";
        if (rawEvent == "notification" && notification == "permission_prompt") return "Notification";
        return "";
    }

    private static string ReadStdin()
    {
        try
        {
            var read = Task.Factory.StartNew(() =>
            {
                try
                {
                    return Console.In.ReadToEnd() ?? "";
                }
                catch
                {
                    return "";
                }
            });
            if (read.Wait(1200))
            {
                var text = read.Result ?? "";
                return text.Length > 1024 * 1024 ? "" : text;
            }
        }
        catch
        {
            return "";
        }
        return "";
    }

    private static string JsonString(string json, string key)
    {
        if (json.Length == 0)
        {
            return "";
        }
        var match = Regex.Match(
            json,
            "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
        if (!match.Success)
        {
            return "";
        }
        return Unescape(match.Groups[1].Value);
    }

    private static string Unescape(string value)
    {
        var builder = new StringBuilder(value.Length);
        for (var index = 0; index < value.Length; index++)
        {
            var ch = value[index];
            if (ch != '\\' || index + 1 >= value.Length)
            {
                builder.Append(ch);
                continue;
            }
            index++;
            var next = value[index];
            if (next == 'n') builder.Append('\n');
            else if (next == 'r') builder.Append('\r');
            else if (next == 't') builder.Append('\t');
            else builder.Append(next);
        }
        return builder.ToString();
    }

    private static void Send(
        string pipePath,
        string token,
        string eventName,
        string notification,
        string toolUseId,
        string sessionId,
        bool release)
    {
        var name = pipePath;
        const string prefix = "\\\\.\\pipe\\";
        if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            name = name.Substring(prefix.Length);
        }
        using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.Out))
        {
            pipe.Connect(1500);
            var payload = new StringBuilder();
            payload.Append("{\"v\":1,\"type\":\"hook\",\"token\":\"");
            payload.Append(Esc(token));
            payload.Append("\",\"event\":\"");
            payload.Append(Esc(eventName));
            payload.Append("\"");
            if (eventName == "Notification" && notification.Length > 0)
            {
                payload.Append(",\"hookEvent\":\"");
                payload.Append(Esc(notification));
                payload.Append("\"");
            }
            if (toolUseId.Length > 0 && toolUseId.Length <= 128)
            {
                payload.Append(",\"toolUseId\":\"");
                payload.Append(Esc(toolUseId));
                payload.Append("\"");
            }
            if (sessionId.Length > 0 && sessionId.Length <= 128)
            {
                payload.Append(",\"sessionId\":\"");
                payload.Append(Esc(sessionId));
                payload.Append("\"");
            }
            if (release)
            {
                payload.Append(",\"releasePermissions\":true");
            }
            payload.Append("}\n");
            var bytes = Encoding.UTF8.GetBytes(payload.ToString());
            pipe.Write(bytes, 0, bytes.Length);
            pipe.Flush();
        }
    }

    private static string Esc(string value)
    {
        return value
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\n", "\\n")
            .Replace("\r", "\\r");
    }
}
