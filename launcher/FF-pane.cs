using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

/// <summary>
/// 固定入口。只负责在自己所在目录启动当前源码（pnpm dev）。
/// 改应用代码时不要重新编译这个程序。
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        if (!File.Exists(Path.Combine(dir, "package.json")))
        {
            MessageBox.Show(
                "这个程序要放在项目根目录，旁边要有 package.json。",
                "FF-pane",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        if (FindOnPath("pnpm.cmd") == null && FindOnPath("pnpm.exe") == null)
        {
            MessageBox.Show(
                "找不到 pnpm。先安装 pnpm，再双击这个程序。",
                "FF-pane",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        try
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = "cmd.exe";
            info.Arguments = "/d /c pnpm dev";
            info.WorkingDirectory = dir;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            Process.Start(info);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "FF-pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string FindOnPath(string name)
    {
        string path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(path))
        {
            return null;
        }

        string[] parts = path.Split(';');
        for (int i = 0; i < parts.Length; i++)
        {
            string folder = parts[i].Trim().Trim('"');
            if (folder.Length == 0)
            {
                continue;
            }

            string candidate = Path.Combine(folder, name);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }
}
