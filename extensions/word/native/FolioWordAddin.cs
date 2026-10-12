using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Xml;

[assembly: AssemblyTitle("Folio Word Add-in")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: ComVisible(false)]

[ComVisible(true)]
[Guid("B65AD801-ABAF-11D0-BB8B-00A0C90F2744")]
[InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface IDTExtensibility2
{
    [DispId(1)] void OnConnection(object application, int connectMode, object addInInst, ref Array custom);
    [DispId(2)] void OnDisconnection(int removeMode, ref Array custom);
    [DispId(3)] void OnAddInsUpdate(ref Array custom);
    [DispId(4)] void OnStartupComplete(ref Array custom);
    [DispId(5)] void OnBeginShutdown(ref Array custom);
}

[ComVisible(true)]
[Guid("000C0396-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface IRibbonExtensibility
{
    [DispId(1)] string GetCustomUI(string ribbonId);
}

[ComVisible(true)]
[Guid("E30C6762-4A1F-41C1-A774-DA2C8024B809")]
[InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface IFolioRibbonCallbacks
{
    [DispId(1)] void OpenFolio(object control);
    [DispId(2)] void RefreshFolio(object control);
}

[ComVisible(true)]
[Guid("BF4750C7-9CA5-4C9D-93B7-0DB7349E2F3A")]
[ProgId("Folio.WordAddin")]
[ComDefaultInterface(typeof(IFolioRibbonCallbacks))]
[ClassInterface(ClassInterfaceType.None)]
public sealed class Connect : IDTExtensibility2, IRibbonExtensibility, IFolioRibbonCallbacks
{
    private const string RibbonXml =
        "<customUI xmlns=\"http://schemas.microsoft.com/office/2009/07/customui\"><ribbon><tabs><tab id=\"folioTab\" label=\"Folio\"><group id=\"folioGroup\" label=\"文献引用\"><button id=\"folioOpen\" label=\"搜索并插入引用\" size=\"large\" onAction=\"OpenFolio\"/><button id=\"folioRefresh\" label=\"刷新文档引用\" onAction=\"RefreshFolio\"/></group></tab></tabs></ribbon></customUI>";
    private object application;

    public void OnConnection(object app, int connectMode, object addInInst, ref Array custom) { application = app; }
    public void OnDisconnection(int removeMode, ref Array custom) { application = null; }
    public void OnAddInsUpdate(ref Array custom) { }
    public void OnStartupComplete(ref Array custom) { }
    public void OnBeginShutdown(ref Array custom) { }
    public string GetCustomUI(string ribbonId) { return RibbonXml; }

    public void OpenFolio(object control)
    {
        if (application == null) return;
        FolioForm.Open(application);
    }

    public void RefreshFolio(object control)
    {
        if (application == null) return;
        try { WordDocument.Refresh(application, null, true, true); }
        catch (Exception error) { MessageBox.Show(error.Message, "Folio", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }
}

internal static class FolioRpc
{
    private const int MaxFrame = 1024 * 1024;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxFrame, RecursionLimit = 128 };

    internal static object Call(Dictionary<string, object> request, string secretPath = null, string pipeName = "folio-browser-bridge-v1")
    {
        if (String.IsNullOrEmpty(secretPath)) secretPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Folio", "browser-bridge.secret");
        string secret = File.ReadAllText(secretPath, Encoding.UTF8).Trim();
        if (!Regex.IsMatch(secret, "^[a-f0-9]{64}$")) throw new InvalidOperationException("Folio 本机连接凭证无效，请在 Folio 设置中重试插件连接。");

        using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None))
        {
            pipe.Connect(2500);
            using (System.Threading.Timer timeout = new System.Threading.Timer(delegate { try { pipe.Dispose(); } catch { } }, null, 125000, System.Threading.Timeout.Infinite))
            {
                Dictionary<string, object> auth = new Dictionary<string, object> {
                    { "id", "native-auth" }, { "type", "FOLIO_NATIVE_AUTH" }, { "secret", secret }
                };
                Send(pipe, auth);
                Dictionary<string, object> authResponse = Read(pipe);
                if (!IsTrue(authResponse, "ok")) throw new InvalidOperationException(StringValue(authResponse, "error", "Folio 本机连接未通过身份验证。"));
                request["id"] = Guid.NewGuid().ToString("N");
                Send(pipe, request);
                Dictionary<string, object> response = Read(pipe);
                if (!IsTrue(response, "ok")) throw new InvalidOperationException(StringValue(response, "error", "Folio 本机文献服务暂不可用。"));
                return response.ContainsKey("result") ? response["result"] : null;
            }
        }
    }

    private static void Send(Stream pipe, object value)
    {
        byte[] body = Encoding.UTF8.GetBytes(Json.Serialize(value));
        if (body.Length <= 0 || body.Length > MaxFrame) throw new InvalidOperationException("Word 插件请求超过本机消息大小限制。");
        byte[] header = BitConverter.GetBytes(body.Length);
        pipe.Write(header, 0, header.Length);
        pipe.Write(body, 0, body.Length);
        pipe.Flush();
    }

    private static Dictionary<string, object> Read(Stream pipe)
    {
        byte[] header = ReadExact(pipe, 4);
        int length = BitConverter.ToInt32(header, 0);
        if (length <= 0 || length > MaxFrame) throw new InvalidOperationException("Folio 返回了超出大小限制的本机响应。");
        object value = Json.DeserializeObject(Encoding.UTF8.GetString(ReadExact(pipe, length)));
        Dictionary<string, object> result = value as Dictionary<string, object>;
        if (result == null) throw new InvalidOperationException("Folio 返回了无效的本机响应。");
        return result;
    }

    private static byte[] ReadExact(Stream pipe, int length)
    {
        byte[] bytes = new byte[length];
        int read = 0;
        while (read < length)
        {
            int count = pipe.Read(bytes, read, length - read);
            if (count <= 0) throw new EndOfStreamException("Folio 本机连接提前结束。");
            read += count;
        }
        return bytes;
    }

    internal static Dictionary<string, object> Object(object value) { return value as Dictionary<string, object>; }
    internal static IList List(object value) { return value as IList; }
    internal static string Text(object value) { return value == null ? "" : Convert.ToString(value, CultureInfo.InvariantCulture); }
    internal static string StringValue(IDictionary value, string key, string fallback) { return value != null && value.Contains(key) ? Text(value[key]) : fallback; }
    internal static bool IsTrue(IDictionary value, string key) { return value != null && value.Contains(key) && value[key] is bool && (bool)value[key]; }
    internal static string Normalize(string value) { return Regex.Replace((value ?? "").Replace('\u00a0', ' '), @"\s+", " ").Trim(); }
}

internal static class WordDocument
{
    private const string Namespace = "urn:folio:word:citations:v1";
    private const string CitationPrefix = "folio-cite:";
    private const string BibliographyTag = "folio-bibliography:v1";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 900 * 1024, RecursionLimit = 128 };

    private sealed class ControlSnapshot
    {
        internal object Control;
        internal string Tag;
        internal string Text;
        internal int Start;
        internal bool Manual;
    }

    internal static bool Refresh(object application, string requestedStyle, bool askBeforeApply, bool refreshSources = false)
    {
        dynamic app = application;
        object document = app.ActiveDocument;
        Dictionary<string, object> state = LoadState(document);
        string style = requestedStyle ?? FolioRpc.Text(state["style"]);
        if (style != "apa" && style != "gb-t-7714-2015-numeric") style = "apa";
        List<ControlSnapshot> controls = ReadControls(document);
        Reconcile(state, controls);
        if (ListValue(state, "citations").Count == 0)
        {
            ClearOrPreserveBibliography(document, state, controls);
            RemoveState(document);
            if (askBeforeApply) MessageBox.Show("文档中已没有 Folio 文中引用；托管书目和文档引用状态已清理。", "Folio", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return true;
        }

        state["style"] = style;
        int updatedSources = 0;
        int retainedSources = 0;
        if (refreshSources) updatedSources = RefreshSourceSnapshots(state, style, out retainedSources);
        Dictionary<string, object> requestState = RendererState(state, style);
        Dictionary<string, object> rendered = FolioRpc.Object(FolioRpc.Call(new Dictionary<string, object> {
            { "type", "FOLIO_RENDER_DOCUMENT" }, { "style", style }, { "state", requestState }
        }));
        if (rendered == null) throw new InvalidOperationException("Folio 没有返回文档引用结果。");

        IDictionary citationTexts = FolioRpc.Object(rendered.ContainsKey("citation_texts") ? rendered["citation_texts"] : null);
        IDictionary citationHtml = FolioRpc.Object(rendered.ContainsKey("citations") ? rendered["citations"] : null);
        string bibliographyText = FolioRpc.Text(rendered.ContainsKey("bibliography_text") ? rendered["bibliography_text"] : "");
        string preview = BuildPreview(state, citationTexts, bibliographyText, style);
        if (askBeforeApply && MessageBox.Show(preview + "\r\n\r\n是否按此预览更新文档？手动修改过的引用和书目会保留。", "Folio 引用预览", MessageBoxButtons.YesNo, MessageBoxIcon.Information) != DialogResult.Yes)
        {
            return false;
        }

        foreach (ControlSnapshot snapshot in controls)
        {
            if (snapshot.Tag.StartsWith(CitationPrefix, StringComparison.Ordinal) && snapshot.Control != null
                && Convert.ToString(((dynamic)snapshot.Control).Tag, CultureInfo.InvariantCulture) != snapshot.Tag)
                ((dynamic)snapshot.Control).Tag = snapshot.Tag;
        }

        Dictionary<string, ControlSnapshot> byTag = new Dictionary<string, ControlSnapshot>(StringComparer.Ordinal);
        foreach (ControlSnapshot snapshot in controls) if (!byTag.ContainsKey(snapshot.Tag)) byTag[snapshot.Tag] = snapshot;
        int manualCount = 0;
        foreach (Dictionary<string, object> citation in CitationObjects(state))
        {
            string id = FolioRpc.Text(citation["id"]);
            ControlSnapshot snapshot;
            if (!byTag.TryGetValue(CitationPrefix + id, out snapshot) || snapshot.Control == null) continue;
            if (snapshot.Manual)
            {
                manualCount++;
                continue;
            }
            string text = citationTexts == null ? "" : FolioRpc.Text(citationTexts[id]);
            if (text.Length == 0) continue;
            SetControlText(snapshot.Control, text);
            citation["renderedText"] = text;
            bool superscript = citationHtml != null && citationHtml.Contains(id) && Regex.IsMatch(FolioRpc.Text(citationHtml[id]), @"<sup(?:\s|>)", RegexOptions.IgnoreCase);
            try { ((dynamic)snapshot.Control).Range.Font.Superscript = superscript ? -1 : 0; } catch { }
        }

        string cleanBibliography = SafeBibliographyHtml(rendered);
        ControlSnapshot bibliography = null;
        foreach (ControlSnapshot snapshot in controls) if (snapshot.Tag == BibliographyTag) { bibliography = snapshot; break; }
        bool manualBibliography = bibliography != null && FolioRpc.Normalize(bibliography.Text) != FolioRpc.Normalize(FolioRpc.Text(state["bibliographyText"]));
        if (!String.IsNullOrEmpty(cleanBibliography) && !String.IsNullOrEmpty(bibliographyText))
        {
            if (bibliography == null) bibliography = new ControlSnapshot { Control = AddBibliographyControl(document), Tag = BibliographyTag, Text = "" };
            if (manualBibliography) manualCount++;
            else
            {
                state["bibliographyText"] = SetBibliographyHtml(bibliography.Control, cleanBibliography);
            }
        }
        else if (bibliography != null)
        {
            if (manualBibliography) manualCount++;
            else
            {
                ((dynamic)bibliography.Control).Delete(true);
                state["bibliographyText"] = "";
            }
        }
        else state["bibliographyText"] = "";

        SaveState(document, state);
        string status = "文档引用和参考文献已更新。";
        if (refreshSources) status += " 已同步 " + updatedSources + " 条当前格式已确认的文献快照。";
        if (retainedSources > 0) status += " 另有 " + retainedSources + " 条文献未能同步（尚未确认、确认过期或 Folio 暂不可用），原文档快照已保留。";
        if (manualCount > 0) status += " 保留了 " + manualCount + " 处手动文字修改。";
        IList incomplete = FolioRpc.List(rendered.ContainsKey("incomplete_items") ? rendered["incomplete_items"] : null);
        if (incomplete != null && incomplete.Count > 0) status += " " + incomplete.Count + " 条书目仍有缺失字段，请检查预览。";
        if (askBeforeApply) MessageBox.Show(status + "\r\n请保存 Word 文档。", "Folio", MessageBoxButtons.OK, MessageBoxIcon.Information);
        return true;
    }

    internal static int ReconcileForInsertion(object application, object document, Dictionary<string, object> state, out int selectionStart, out int selectionEnd)
    {
        dynamic app = application;
        dynamic selection = app.Selection.Range;
        selectionStart = Convert.ToInt32(selection.Start, CultureInfo.InvariantCulture);
        selectionEnd = Convert.ToInt32(selection.End, CultureInfo.InvariantCulture);
        int insertionPoint = selectionEnd;
        List<ControlSnapshot> controls = ReadControls(document);
        Reconcile(state, controls);
        HashSet<string> citations = new HashSet<string>(StringComparer.Ordinal);
        foreach (Dictionary<string, object> citation in CitationObjects(state)) citations.Add(FolioRpc.Text(citation["id"]));
        int index = 0;
        foreach (ControlSnapshot control in controls)
        {
            if (control.Start >= insertionPoint || String.IsNullOrWhiteSpace(control.Text)
                || !control.Tag.StartsWith(CitationPrefix, StringComparison.Ordinal)) continue;
            if (citations.Contains(control.Tag.Substring(CitationPrefix.Length))) index++;
        }
        return index;
    }

    internal static Dictionary<string, object> NewCitation(Dictionary<string, object> state, IList selected, string locator, int index, out string citationId)
    {
        Dictionary<string, object> next = state;
        IDictionary items = (IDictionary)next["items"];
        ArrayList citations = (ArrayList)next["citations"];
        ArrayList citationItems = new ArrayList();
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (object value in selected)
        {
            Dictionary<string, object> record = FolioRpc.Object(value);
            if (record == null || !record.ContainsKey("id") || !record.ContainsKey("csl")) continue;
            string id = FolioRpc.Text(record["id"]);
            if (id.Length == 0 || !seen.Add(id)) continue;
            Dictionary<string, object> csl = CloneObject(FolioRpc.Object(record["csl"]));
            if (csl == null) continue;
            csl["id"] = id;
            items[id] = csl;
            Dictionary<string, object> citationItem = new Dictionary<string, object> { { "id", id } };
            if (!String.IsNullOrWhiteSpace(locator))
            {
                citationItem["locator"] = locator.Trim();
                citationItem["label"] = "page";
            }
            citationItems.Add(citationItem);
        }
        if (citationItems.Count == 0) throw new InvalidOperationException("请选择至少一条具有 CSL 元数据的文献。");
        citationId = NewId();
        Dictionary<string, object> citation = new Dictionary<string, object> { { "id", citationId }, { "items", citationItems } };
        citations.Insert(Math.Min(index, citations.Count), citation);
        next["style"] = FolioRpc.Text(state["style"]);
        return next;
    }

    internal static void Insert(object application, object expectedDocument, int expectedSelectionStart, int expectedSelectionEnd,
        Dictionary<string, object> state, string citationId, string citationText, string citationHtml)
    {
        dynamic app = application;
        object activeDocument = app.ActiveDocument;
        if (!SameComObject(activeDocument, expectedDocument))
            throw new InvalidOperationException("预览期间 Word 的活动文档已切换；未插入引用。请返回原文档后重试。");
        object document = expectedDocument;
        dynamic selection = app.Selection.Range;
        if (!SameComObject(selection.Document, expectedDocument))
            throw new InvalidOperationException("当前光标不在预览时的 Word 文档中；未插入引用。请返回原文档后重试。");
        int selectionStart = Convert.ToInt32(selection.Start, CultureInfo.InvariantCulture);
        int selectionEnd = Convert.ToInt32(selection.End, CultureInfo.InvariantCulture);
        if (selectionStart != expectedSelectionStart || selectionEnd != expectedSelectionEnd)
            throw new InvalidOperationException("预览期间 Word 中的选区已更改；未插入引用。请重新预览后重试。");
        dynamic doc = document;
        object insertRange = doc.Range(expectedSelectionEnd, expectedSelectionEnd);
        object citationControl = null;
        foreach (Dictionary<string, object> citation in CitationObjects(state))
            if (FolioRpc.Text(citation["id"]) == citationId) { citation["renderedText"] = citationText; break; }
        try
        {
            citationControl = doc.ContentControls.Add(0, insertRange);
            dynamic value = citationControl;
            value.Tag = CitationPrefix + citationId;
            value.Title = "Folio citation";
            SetControlText(citationControl, citationText);
            value.Range.Font.Superscript = Regex.IsMatch(citationHtml ?? "", @"<sup(?:\s|>)", RegexOptions.IgnoreCase) ? -1 : 0;
            SaveState(document, state);
        }
        catch
        {
            if (citationControl != null) try { ((dynamic)citationControl).Delete(true); } catch { }
            throw;
        }
        Refresh(application, FolioRpc.Text(state["style"]), false);
    }

    private static bool SameComObject(object left, object right)
    {
        if (left == null || right == null || !Marshal.IsComObject(left) || !Marshal.IsComObject(right)) return false;
        IntPtr leftUnknown = IntPtr.Zero;
        IntPtr rightUnknown = IntPtr.Zero;
        try
        {
            leftUnknown = Marshal.GetIUnknownForObject(left);
            rightUnknown = Marshal.GetIUnknownForObject(right);
            return leftUnknown == rightUnknown;
        }
        finally
        {
            if (leftUnknown != IntPtr.Zero) Marshal.Release(leftUnknown);
            if (rightUnknown != IntPtr.Zero) Marshal.Release(rightUnknown);
        }
    }

    private static List<ControlSnapshot> ReadControls(object document)
    {
        dynamic doc = document;
        dynamic controls = doc.ContentControls;
        int count = Convert.ToInt32(controls.Count, CultureInfo.InvariantCulture);
        List<ControlSnapshot> result = new List<ControlSnapshot>();
        for (int index = 1; index <= count; index++)
        {
            object control = controls.Item(index);
            dynamic value = control;
            string tag = Convert.ToString(value.Tag, CultureInfo.InvariantCulture) ?? "";
            if (tag != BibliographyTag && !tag.StartsWith(CitationPrefix, StringComparison.Ordinal)) continue;
            string text = Convert.ToString(value.Range.Text, CultureInfo.InvariantCulture) ?? "";
            int start = Convert.ToInt32(value.Range.Start, CultureInfo.InvariantCulture);
            result.Add(new ControlSnapshot { Control = control, Tag = tag, Text = text, Start = start });
        }
        result.Sort(delegate(ControlSnapshot a, ControlSnapshot b) { return a.Start.CompareTo(b.Start); });
        return result;
    }

    private static void Reconcile(Dictionary<string, object> state, List<ControlSnapshot> controls)
    {
        Dictionary<string, Dictionary<string, object>> citationsById = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
        HashSet<string> reserved = new HashSet<string>(StringComparer.Ordinal);
        foreach (Dictionary<string, object> citation in CitationObjects(state))
        {
            string id = FolioRpc.Text(citation["id"]);
            reserved.Add(id);
            if (!citationsById.ContainsKey(id)) citationsById[id] = citation;
        }
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        ArrayList ordered = new ArrayList();
        foreach (ControlSnapshot control in controls)
        {
            if (!control.Tag.StartsWith(CitationPrefix, StringComparison.Ordinal) || String.IsNullOrWhiteSpace(control.Text)) continue;
            string id = control.Tag.Substring(CitationPrefix.Length);
            Dictionary<string, object> citation;
            if (!citationsById.TryGetValue(id, out citation)) continue;
            if (seen.Contains(id))
            {
                citation = CloneObject(citation);
                string copyId;
                do { copyId = NewId(); } while (reserved.Contains(copyId));
                reserved.Add(copyId);
                citation["id"] = copyId;
                control.Tag = CitationPrefix + copyId;
            }
            else seen.Add(id);
            string expected = FolioRpc.Text(citation.ContainsKey("renderedText") ? citation["renderedText"] : "");
            control.Manual = expected.Length > 0 && FolioRpc.Normalize(control.Text) != FolioRpc.Normalize(expected);
            ordered.Add(citation);
        }
        state["citations"] = ordered;
        IDictionary items = (IDictionary)state["items"];
        HashSet<string> used = new HashSet<string>(StringComparer.Ordinal);
        foreach (Dictionary<string, object> citation in CitationObjects(state))
            foreach (Dictionary<string, object> item in CitationItemObjects(citation)) used.Add(FolioRpc.Text(item["id"]));
        ArrayList remove = new ArrayList();
        foreach (object key in items.Keys) if (!used.Contains(Convert.ToString(key, CultureInfo.InvariantCulture))) remove.Add(key);
        foreach (object key in remove) items.Remove(key);
    }

    private static int RefreshSourceSnapshots(Dictionary<string, object> state, string style, out int retained)
    {
        retained = 0;
        IDictionary items = state["items"] as IDictionary;
        if (items == null) return 0;
        HashSet<string> ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (Dictionary<string, object> citation in CitationObjects(state))
            foreach (Dictionary<string, object> item in CitationItemObjects(citation)) ids.Add(FolioRpc.Text(item["id"]));
        int updated = 0;
        List<string> orderedIds = new List<string>(ids);
        for (int index = 0; index < orderedIds.Count; index++)
        {
            string id = orderedIds[index];
            try
            {
                Dictionary<string, object> record = FolioRpc.Object(FolioRpc.Call(new Dictionary<string, object> {
                    { "type", "FOLIO_GET_RECORD" }, { "recordId", id }
                }));
                IDictionary citations = record == null ? null : FolioRpc.Object(record.ContainsKey("citations") ? record["citations"] : null);
                IDictionary confirmed = citations == null ? null : FolioRpc.Object(citations[style]);
                if (record == null || FolioRpc.Text(record.ContainsKey("id") ? record["id"] : "") != id
                    || !FolioRpc.IsTrue(confirmed, "confirmed") || FolioRpc.IsTrue(confirmed, "stale")
                    || FolioRpc.StringValue(confirmed, "fingerprint", "").Length == 0)
                {
                    retained++;
                    continue;
                }
                Dictionary<string, object> csl = CloneObject(FolioRpc.Object(record.ContainsKey("csl") ? record["csl"] : null));
                if (csl == null) { retained++; continue; }
                csl["id"] = id;
                items[id] = csl;
                updated++;
            }
            catch (TimeoutException) { retained += orderedIds.Count - index; break; }
            catch (IOException) { retained += orderedIds.Count - index; break; }
            catch { retained++; }
        }
        return updated;
    }

    private static void ClearOrPreserveBibliography(object document, Dictionary<string, object> state, List<ControlSnapshot> controls)
    {
        string expected = FolioRpc.Normalize(FolioRpc.Text(state["bibliographyText"]));
        foreach (ControlSnapshot control in controls)
        {
            if (control.Tag != BibliographyTag || control.Control == null) continue;
            if (expected.Length > 0 && FolioRpc.Normalize(control.Text) == expected) ((dynamic)control.Control).Delete(true);
            else ((dynamic)control.Control).Tag = "folio-manual-bibliography";
        }
        state["bibliographyText"] = "";
    }

    internal static Dictionary<string, object> RendererState(Dictionary<string, object> state, string style)
    {
        ArrayList citations = new ArrayList();
        foreach (Dictionary<string, object> citation in CitationObjects(state))
        {
            ArrayList items = new ArrayList();
            foreach (Dictionary<string, object> item in CitationItemObjects(citation))
            {
                Dictionary<string, object> clean = new Dictionary<string, object> { { "id", item["id"] } };
                if (item.ContainsKey("locator")) clean["locator"] = item["locator"];
                if (item.ContainsKey("label")) clean["label"] = item["label"];
                items.Add(clean);
            }
            citations.Add(new Dictionary<string, object> { { "id", citation["id"] }, { "items", items } });
        }
        return new Dictionary<string, object> {
            { "version", 1 }, { "style", style }, { "items", state["items"] }, { "citations", citations }
        };
    }

    private static string BuildPreview(Dictionary<string, object> state, IDictionary citationTexts, string bibliographyText, string style)
    {
        StringBuilder result = new StringBuilder();
        result.Append("格式：").Append(style == "apa" ? "APA 7" : "GB/T 7714-2015 顺序编码制").AppendLine();
        result.AppendLine("文中引用预览：");
        int shown = 0;
        foreach (Dictionary<string, object> citation in CitationObjects(state))
        {
            string id = FolioRpc.Text(citation["id"]);
            result.Append("• ").AppendLine(citationTexts == null ? "" : FolioRpc.Text(citationTexts[id]));
            if (++shown >= 12) { result.AppendLine("（其余引用已省略）"); break; }
        }
        result.AppendLine().AppendLine("参考文献预览：").AppendLine(bibliographyText);
        return result.ToString();
    }

    internal static string SafeBibliographyHtml(Dictionary<string, object> rendered)
    {
        Dictionary<string, object> bibliography = FolioRpc.Object(rendered.ContainsKey("bibliography") ? rendered["bibliography"] : null);
        if (bibliography == null) return "";
        IDictionary parameters = FolioRpc.Object(bibliography.ContainsKey("parameters") ? bibliography["parameters"] : null);
        IList entries = FolioRpc.List(bibliography.ContainsKey("entries") ? bibliography["entries"] : null);
        if (entries == null) return "";
        StringBuilder body = new StringBuilder();
        bool hanging = parameters != null && ((parameters.Contains("hangingindent") && Convert.ToString(parameters["hangingindent"], CultureInfo.InvariantCulture) == "true")
            || (parameters.Contains("second-field-align") && Convert.ToString(parameters["second-field-align"], CultureInfo.InvariantCulture) == "flush"));
        string lineHeight = parameters != null && parameters.Contains("linespacing") && Convert.ToString(parameters["linespacing"], CultureInfo.InvariantCulture) == "2" ? "2" : "1";
        foreach (object entry in entries)
        {
            string html = FolioRpc.Text(entry);
            html = Regex.Replace(html, "<div\\b[^>]*class\\s*=\\s*(['\"])[^'\"]*csl-left-margin[^'\"]*\\1[^>]*>([\\s\\S]*?)</div\\s*>", "$2&nbsp;&nbsp;", RegexOptions.IgnoreCase);
            html = Regex.Replace(html, "<div\\b[^>]*class\\s*=\\s*(['\"])[^'\"]*csl-right-inline[^'\"]*\\1[^>]*>([\\s\\S]*?)</div\\s*>", "$2", RegexOptions.IgnoreCase);
            html = Regex.Replace(html, "</?div\\b[^>]*>", "", RegexOptions.IgnoreCase);
            string safe = SanitizeHtml(html);
            string style = "line-height:" + lineHeight + ";" + (hanging ? "margin-left:36pt;text-indent:-36pt;" : "");
            body.Append("<p style=\"").Append(style).Append("\">").Append(safe).Append("</p>");
        }
        return "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>" + body + "</body></html>";
    }

    private static string SanitizeHtml(string html)
    {
        html = Regex.Replace(html ?? "", @"<(script|style|iframe|object)\b[^>]*>.*?</\1\s*>", "", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        return Regex.Replace(html, @"<(\/)?([A-Za-z][A-Za-z0-9]*)([^>]*)>", delegate(Match match)
        {
            string tag = match.Groups[2].Value.ToLowerInvariant();
            if (tag != "i" && tag != "em" && tag != "b" && tag != "strong" && tag != "sup" && tag != "sub" && tag != "span" && tag != "br" && tag != "a") return "";
            string slash = match.Groups[1].Success ? "/" : "";
            if (tag == "br") return slash.Length == 0 ? "<br/>" : "";
            if (tag == "a" && slash.Length == 0)
            {
                Match href = Regex.Match(match.Groups[3].Value, "\\bhref\\s*=\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase);
                if (!href.Success) href = Regex.Match(match.Groups[3].Value, @"\bhref\s*=\s*'([^']+)'", RegexOptions.IgnoreCase);
                Uri uri;
                if (href.Success && Uri.TryCreate(href.Groups[1].Value, UriKind.Absolute, out uri) && (uri.Scheme == "https" || uri.Scheme == "http"))
                    return "<a href=\"" + SecurityElement.Escape(uri.ToString()) + "\">";
            }
            return "<" + slash + tag + ">";
        }, RegexOptions.IgnoreCase);
    }

    private static void SetControlText(object control, string text)
    {
        dynamic value = control;
        value.Range.Text = text ?? "";
    }

    private static string SetBibliographyHtml(object control, string html)
    {
        string filename = Path.Combine(Path.GetTempPath(), "folio-word-bibliography-" + Guid.NewGuid().ToString("N") + ".html");
        try
        {
            File.WriteAllText(filename, html, new UTF8Encoding(false));
            dynamic value = control;
            value.Range.Text = "";
            value.Range.InsertFile(filename);
            return Convert.ToString(value.Range.Text, CultureInfo.InvariantCulture) ?? "";
        }
        finally { try { File.Delete(filename); } catch { } }
    }

    private static object AddBibliographyControl(object document)
    {
        dynamic doc = document;
        dynamic end = doc.Content;
        end.Collapse(0);
        end.InsertParagraphAfter();
        end.Collapse(0);
        dynamic control = doc.ContentControls.Add(0, end);
        control.Tag = BibliographyTag;
        control.Title = "Folio bibliography";
        return control;
    }

    internal static Dictionary<string, object> LoadState(object document)
    {
        Dictionary<string, object> empty = new Dictionary<string, object> {
            { "version", 1 }, { "style", "apa" }, { "items", new Dictionary<string, object>() },
            { "citations", new ArrayList() }, { "bibliographyText", "" }
        };
        int count = 0;
        Dictionary<string, object> state = null;
        try
        {
            dynamic doc = document;
            dynamic parts = doc.CustomXMLParts.SelectByNamespace(Namespace);
            count = Convert.ToInt32(parts.Count, CultureInfo.InvariantCulture);
            long bestRevision = Int64.MinValue;
            for (int index = 1; index <= count; index++)
            {
                try
                {
                    XmlDocument parsed = new XmlDocument();
                    parsed.LoadXml(Convert.ToString(parts.Item(index).XML, CultureInfo.InvariantCulture));
                    XmlElement root = parsed.DocumentElement;
                    long revision = 0;
                    if (root != null) Int64.TryParse(root.GetAttribute("revision"), NumberStyles.Integer, CultureInfo.InvariantCulture, out revision);
                    XmlNode json = parsed.SelectSingleNode("/*[local-name()='state']/*[local-name()='json']");
                    if (json == null) continue;
                    Dictionary<string, object> candidate = FolioRpc.Object(Json.DeserializeObject(json.InnerText));
                    if (candidate == null || !candidate.ContainsKey("version") || Convert.ToInt32(candidate["version"], CultureInfo.InvariantCulture) != 1
                        || !candidate.ContainsKey("items") || !(candidate["items"] is IDictionary) || !candidate.ContainsKey("citations") || !(candidate["citations"] is IList)) continue;
                    if (revision < bestRevision) continue;
                    state = candidate;
                    bestRevision = revision;
                }
                catch { }
            }
        }
        catch { throw new InvalidOperationException("无法读取文档中的 Folio 快照；为保护现有内容，已停止插入或刷新。"); }
        if (count < 1) return EmptyStateOrThrowForLegacy(document, empty);
        if (state == null) throw new InvalidOperationException("文档中存在无法读取的 Folio 快照；为保护现有内容，已停止插入或刷新。");
        if (!state.ContainsKey("style") || (FolioRpc.Text(state["style"]) != "apa" && FolioRpc.Text(state["style"]) != "gb-t-7714-2015-numeric")) state["style"] = "apa";
        if (!state.ContainsKey("bibliographyText")) state["bibliographyText"] = "";
        return state;
    }

    private static void SaveState(object document, Dictionary<string, object> state)
    {
        string json = Json.Serialize(state);
        dynamic doc = document;
        dynamic parts = doc.CustomXMLParts.SelectByNamespace(Namespace);
        int count = Convert.ToInt32(parts.Count, CultureInfo.InvariantCulture);
        List<object> oldParts = new List<object>();
        long revision = 0;
        for (int index = 1; index <= count; index++)
        {
            object part = parts.Item(index);
            oldParts.Add(part);
            try
            {
                XmlDocument oldXml = new XmlDocument();
                oldXml.LoadXml(Convert.ToString(((dynamic)part).XML, CultureInfo.InvariantCulture));
                long oldRevision;
                if (Int64.TryParse(oldXml.DocumentElement.GetAttribute("revision"), NumberStyles.Integer, CultureInfo.InvariantCulture, out oldRevision))
                    revision = Math.Max(revision, oldRevision);
            }
            catch { }
        }
        XmlDocument xml = new XmlDocument();
        XmlElement root = xml.CreateElement("folio", "state", Namespace);
        root.SetAttribute("revision", (revision + 1).ToString(CultureInfo.InvariantCulture));
        xml.AppendChild(root);
        XmlElement payload = xml.CreateElement("folio", "json", Namespace);
        payload.InnerText = json;
        root.AppendChild(payload);
        doc.CustomXMLParts.Add(xml.OuterXml);
        foreach (object oldPart in oldParts) try { ((dynamic)oldPart).Delete(); } catch { }
    }

    private static Dictionary<string, object> EmptyStateOrThrowForLegacy(object document, Dictionary<string, object> empty)
    {
        if (HasFolioControls(document))
            throw new InvalidOperationException("此文档包含 Folio 标记的引用或书目控件，但缺少本机插件可读取的文档快照。当前不能自动迁移旧版 Office.js 状态；为保护现有文本，已停止插入或刷新。请在文档副本中处理旧引用后再使用本机插件。");
        return empty;
    }

    private static bool HasFolioControls(object document)
    {
        try
        {
            dynamic controls = ((dynamic)document).ContentControls;
            int count = Convert.ToInt32(controls.Count, CultureInfo.InvariantCulture);
            for (int index = 1; index <= count; index++)
            {
                string tag = Convert.ToString(controls.Item(index).Tag, CultureInfo.InvariantCulture) ?? "";
                if (tag == BibliographyTag || tag.StartsWith(CitationPrefix, StringComparison.Ordinal)) return true;
            }
        }
        catch { throw new InvalidOperationException("无法安全读取此文档的 Word 控件状态；为避免覆盖现有引用，Folio 已停止插入或刷新。请检查文档后重试。"); }
        return false;
    }

    private static void RemoveState(object document)
    {
        dynamic doc = document;
        dynamic parts = doc.CustomXMLParts.SelectByNamespace(Namespace);
        while (Convert.ToInt32(parts.Count, CultureInfo.InvariantCulture) > 0) parts.Item(1).Delete();
    }

    internal static List<Dictionary<string, object>> CitationObjects(Dictionary<string, object> state)
    {
        List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
        IList source = ListValue(state, "citations");
        foreach (object item in source)
        {
            Dictionary<string, object> citation = FolioRpc.Object(item);
            if (citation != null && citation.ContainsKey("id") && citation.ContainsKey("items") && citation["items"] is IList) result.Add(citation);
        }
        return result;
    }

    private static List<Dictionary<string, object>> CitationItemObjects(Dictionary<string, object> citation)
    {
        List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
        IList items = citation["items"] as IList;
        if (items != null) foreach (object value in items) { Dictionary<string, object> item = FolioRpc.Object(value); if (item != null && item.ContainsKey("id")) result.Add(item); }
        return result;
    }

    private static IList ListValue(Dictionary<string, object> value, string key)
    {
        return value != null && value.ContainsKey(key) ? FolioRpc.List(value[key]) ?? new ArrayList() : new ArrayList();
    }

    private static Dictionary<string, object> CloneObject(IDictionary value)
    {
        return value == null ? null : FolioRpc.Object(Json.DeserializeObject(Json.Serialize(value)));
    }

    private static string NewId() { return "c" + Guid.NewGuid().ToString("N"); }
}

internal sealed class FolioForm : Form
{
    private readonly object application;
    private readonly TextBox query = new TextBox();
    private readonly ComboBox folders = new ComboBox();
    private readonly ComboBox styles = new ComboBox();
    private readonly TextBox locator = new TextBox();
    private readonly ListView results = new ListView();
    private readonly Label status = new Label();
    private readonly Button preview = new Button();
    private readonly Button insert = new Button();
    private readonly Button refresh = new Button();
    private string folderId = "";
    private static FolioForm current;

    private FolioForm(object wordApplication)
    {
        application = wordApplication;
        Text = "Folio 文献与引用";
        Width = 760;
        Height = 600;
        MinimumSize = new Size(650, 470);
        StartPosition = FormStartPosition.CenterParent;
        BuildControls();
        Shown += delegate { LoadFolders(); LoadDocumentStyle(); };
    }

    internal static void Open(object application)
    {
        if (current != null && !current.IsDisposed) { current.Activate(); return; }
        current = new FolioForm(application);
        current.FormClosed += delegate { current = null; };
        current.Show();
    }

    private void BuildControls()
    {
        TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, Padding = new Padding(12) };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        FlowLayoutPanel filters = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        folders.DropDownStyle = ComboBoxStyle.DropDownList; folders.Width = 180;
        styles.DropDownStyle = ComboBoxStyle.DropDownList; styles.Width = 180;
        styles.Items.Add(new StyleChoice("apa", "APA 7"));
        styles.Items.Add(new StyleChoice("gb-t-7714-2015-numeric", "GB/T 7714-2015 顺序编码制"));
        styles.SelectedIndex = 0;
        styles.SelectedIndexChanged += delegate { UpdateButtons(); };
        filters.Controls.Add(folders); filters.Controls.Add(styles);
        FlowLayoutPanel search = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        query.Width = 565;
        Button searchButton = new Button { Text = "搜索文献", Width = 100 };
        searchButton.Click += delegate { Search(); };
        query.KeyDown += delegate(object sender, KeyEventArgs args) { if (args.KeyCode == Keys.Enter) { args.SuppressKeyPress = true; Search(); } };
        search.Controls.Add(query); search.Controls.Add(searchButton);
        results.Dock = DockStyle.Fill; results.View = View.Details; results.FullRowSelect = true; results.MultiSelect = true;
        results.Columns.Add("文献 / 确认状态", 360); results.Columns.Add("缺失字段", 250);
        results.SelectedIndexChanged += delegate { UpdateButtons(); };
        results.DoubleClick += delegate { PreviewSelected(); };
        FlowLayoutPanel locators = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(0, 8, 0, 0) };
        locators.Controls.Add(new Label { Text = "页码定位符（可选）", AutoSize = true, Margin = new Padding(0, 6, 8, 0) });
        locator.Width = 180; locators.Controls.Add(locator);
        status.Dock = DockStyle.Fill; status.TextAlign = ContentAlignment.MiddleLeft; status.Text = "正在连接 Folio…";
        LinkLabel attribution = new LinkLabel { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft,
            Text = "引用格式由 citeproc-js 提供，作者 Frank Bennett · 项目主页" };
        int projectLink = attribution.Text.IndexOf("项目主页", StringComparison.Ordinal);
        attribution.Links.Add(projectLink, "项目主页".Length, "https://github.com/Juris-M/citeproc-js");
        attribution.LinkClicked += delegate(object sender, LinkLabelLinkClickedEventArgs args) {
            Process.Start(Convert.ToString(args.Link.LinkData, CultureInfo.InvariantCulture));
        };
        FlowLayoutPanel actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft };
        Button close = new Button { Text = "关闭", Width = 88 };
        preview.Text = "预览 / 确认"; preview.Width = 110; preview.Enabled = false; preview.Click += delegate { PreviewSelected(); };
        insert.Text = "插入所选"; insert.Width = 100; insert.Enabled = false; insert.Click += delegate { InsertSelected(); };
        refresh.Text = "刷新文档"; refresh.Width = 95; refresh.Click += delegate { RefreshDocument(); };
        close.Click += delegate { Close(); };
        actions.Controls.Add(close); actions.Controls.Add(insert); actions.Controls.Add(preview); actions.Controls.Add(refresh);
        layout.Controls.Add(filters, 0, 0); layout.Controls.Add(search, 0, 1); layout.Controls.Add(results, 0, 2); layout.Controls.Add(locators, 0, 3); layout.Controls.Add(status, 0, 4); layout.Controls.Add(attribution, 0, 5);
        Controls.Add(layout); Controls.Add(actions);
        actions.Dock = DockStyle.Bottom; actions.Height = 42; layout.Dock = DockStyle.Fill;
    }

    private void LoadFolders()
    {
        try
        {
            IList values = FolioRpc.List(FolioRpc.Call(new Dictionary<string, object> { { "type", "FOLIO_FOLDERS" } }));
            folders.Items.Clear(); folders.Items.Add(new FolderChoice("", "全部文件夹"));
            if (values != null) foreach (object value in values)
            {
                Dictionary<string, object> folder = FolioRpc.Object(value);
                if (folder == null || !folder.ContainsKey("id")) continue;
                folders.Items.Add(new FolderChoice(FolioRpc.Text(folder["id"]), FolioRpc.Text(folder.ContainsKey("name") ? folder["name"] : "")));
            }
            folders.SelectedIndex = 0;
            folders.SelectedIndexChanged += delegate { Search(); };
            status.Text = "已连接 Folio。输入题名、作者、DOI 或关键词开始搜索。";
        }
        catch (Exception error) { status.Text = error.Message + "；启动 Folio 后可重试。"; }
    }

    private void LoadDocumentStyle()
    {
        try
        {
            Dictionary<string, object> state = WordDocument.LoadState(((dynamic)application).ActiveDocument);
            string savedStyle = FolioRpc.Text(state["style"]);
            for (int index = 0; index < styles.Items.Count; index++)
            {
                StyleChoice choice = styles.Items[index] as StyleChoice;
                if (choice != null && choice.Id == savedStyle) { styles.SelectedIndex = index; break; }
            }
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private string CurrentStyle()
    {
        StyleChoice choice = styles.SelectedItem as StyleChoice;
        return choice == null ? "apa" : choice.Id;
    }

    private void Search()
    {
        string text = query.Text.Trim();
        if (text.Length == 0) { status.Text = "请输入搜索内容；空查询不会加载全部文献。"; return; }
        try
        {
            FolderChoice folder = folders.SelectedItem as FolderChoice;
            folderId = folder == null ? "" : folder.Id;
            Dictionary<string, object> request = new Dictionary<string, object> {
                { "type", "FOLIO_SEARCH" }, { "query", text }
            };
            if (folderId.Length > 0) request["folderId"] = folderId;
            Dictionary<string, object> response = FolioRpc.Object(FolioRpc.Call(request));
            results.Items.Clear();
            IList items = response == null ? null : FolioRpc.List(response.ContainsKey("items") ? response["items"] : null);
            if (items != null) foreach (object item in items)
            {
                Dictionary<string, object> record = FolioRpc.Object(item);
                if (record == null || !record.ContainsKey("csl")) continue;
                IDictionary citationStates = FolioRpc.Object(record.ContainsKey("citations") ? record["citations"] : null);
                IDictionary citation = citationStates == null ? null : FolioRpc.Object(citationStates[CurrentStyle()]);
                string savedText = citation == null ? "未确认" : (FolioRpc.IsTrue(citation, "confirmed") && !FolioRpc.IsTrue(citation, "stale") ? "已确认 · " + FolioRpc.Text(citation["citation_text"]) : "需预览确认");
                ListViewItem row = new ListViewItem(FolioRpc.Text(record.ContainsKey("title") ? record["title"] : "未提供题名") + "  —  " + savedText);
                IList missing = FolioRpc.List(record.ContainsKey("missing_fields") ? record["missing_fields"] : null);
                row.SubItems.Add(missing == null ? "" : String.Join("、", ToStrings(missing)));
                row.Tag = record;
                results.Items.Add(row);
            }
            status.Text = results.Items.Count + " 条文献。未确认或已过期的预览不会插入；可先预览并确认。";
            UpdateButtons();
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private void PreviewSelected()
    {
        if (results.SelectedItems.Count != 1) { status.Text = "请只选中一条文献以预览或确认。"; return; }
        Dictionary<string, object> record = FolioRpc.Object(results.SelectedItems[0].Tag);
        if (record == null) return;
        string style = CurrentStyle();
        try
        {
            IDictionary citations = FolioRpc.Object(record.ContainsKey("citations") ? record["citations"] : null);
            IDictionary saved = citations == null ? null : FolioRpc.Object(citations[style]);
            bool confirmed = FolioRpc.IsTrue(saved, "confirmed") && !FolioRpc.IsTrue(saved, "stale");
            Dictionary<string, object> rendered = confirmed
                ? new Dictionary<string, object> {
                    { "citation_text", saved["citation_text"] }, { "bibliography_text", saved["bibliography_text"] },
                    { "fingerprint", saved["fingerprint"] }
                }
                : FolioRpc.Object(FolioRpc.Call(new Dictionary<string, object> { { "type", "FOLIO_PREVIEW" }, { "style", style }, { "record", record["csl"] } }));
            if (rendered == null) throw new InvalidOperationException("Folio 没有返回引用预览。");
            IList missing = FolioRpc.List(record.ContainsKey("missing_fields") ? record["missing_fields"] : null);
            string details = (style == "apa" ? "APA 7" : "GB/T 7714-2015") + " 引用预览\r\n\r\n文中引用：\r\n"
                + FolioRpc.Text(rendered.ContainsKey("citation_text") ? rendered["citation_text"] : "")
                + "\r\n\r\n参考文献：\r\n" + FolioRpc.Text(rendered.ContainsKey("bibliography_text") ? rendered["bibliography_text"] : "")
                + "\r\n\r\n缺失字段：" + (missing == null || missing.Count == 0 ? "无" : String.Join("、", ToStrings(missing)))
                + (confirmed ? "\r\n\r\n此格式已有有效确认。" : "\r\n\r\n确认此预览后，才可将该文献插入 Word。");
            DialogResult answer = MessageBox.Show(details, "Folio 引用预览", MessageBoxButtons.YesNo, MessageBoxIcon.Information,
                MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes || confirmed) return;
            FolioRpc.Call(new Dictionary<string, object> {
                { "type", "FOLIO_CONFIRM" }, { "recordId", record["id"] }, { "style", style }, { "fingerprint", rendered["fingerprint"] }
            });
            Search();
            status.Text = "引用预览已确认；请重新选择文献后插入。";
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private void InsertSelected()
    {
        if (results.SelectedItems.Count == 0) return;
        string style = CurrentStyle();
        ArrayList selected = new ArrayList();
        foreach (ListViewItem row in results.SelectedItems)
        {
            Dictionary<string, object> record = FolioRpc.Object(row.Tag);
            if (record == null) continue;
            IDictionary citations = FolioRpc.Object(record.ContainsKey("citations") ? record["citations"] : null);
            IDictionary citation = citations == null ? null : FolioRpc.Object(citations[style]);
            if (!FolioRpc.IsTrue(citation, "confirmed") || FolioRpc.IsTrue(citation, "stale"))
            {
                status.Text = "所选文献中有未确认或已过期的预览；请先预览确认。";
                return;
            }
            selected.Add(record);
        }
        try
        {
            List<Dictionary<string, object>> cachedSelected = ToRecords(selected);
            ArrayList freshSelected = new ArrayList();
            foreach (Dictionary<string, object> cached in cachedSelected) freshSelected.Add(GetFreshConfirmedRecord(cached, style));
            object document = ((dynamic)application).ActiveDocument;
            Dictionary<string, object> state = WordDocument.LoadState(document);
            state["style"] = style;
            int selectionStart;
            int selectionEnd;
            int insertionIndex = WordDocument.ReconcileForInsertion(application, document, state, out selectionStart, out selectionEnd);
            string citationId;
            state = WordDocument.NewCitation(state, freshSelected, locator.Text, insertionIndex, out citationId);
            Dictionary<string, object> rendered = FolioRpc.Object(FolioRpc.Call(new Dictionary<string, object> {
                { "type", "FOLIO_RENDER_DOCUMENT" }, { "style", style }, { "state", WordDocument.RendererState(state, style) }
            }));
            if (rendered == null) throw new InvalidOperationException("Folio 没有返回文档引用预览。");
            IList incomplete = FolioRpc.List(rendered.ContainsKey("incomplete_items") ? rendered["incomplete_items"] : null);
            IDictionary citationTexts = FolioRpc.Object(rendered.ContainsKey("citation_texts") ? rendered["citation_texts"] : null);
            IDictionary citationHtml = FolioRpc.Object(rendered.ContainsKey("citations") ? rendered["citations"] : null);
            string citationText = citationTexts == null ? "" : FolioRpc.Text(citationTexts[citationId]);
            string html = citationHtml == null ? "" : FolioRpc.Text(citationHtml[citationId]);
            string bibliography = FolioRpc.Text(rendered.ContainsKey("bibliography_text") ? rendered["bibliography_text"] : "");
            string previewText = "文中引用：\r\n" + citationText + "\r\n\r\n文末参考文献预览：\r\n" + bibliography;
            if (incomplete != null && incomplete.Count > 0) previewText += "\r\n\r\n缺失字段提醒（可在 Folio 文献管理中补充）：\r\n" + DescribeIncomplete(incomplete);
            if (MessageBox.Show(previewText + "\r\n\r\n确认插入此引用？", "Folio 插入预览", MessageBoxButtons.YesNo, MessageBoxIcon.Information,
                MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            for (int index = 0; index < cachedSelected.Count; index++)
            {
                Dictionary<string, object> latest = GetFreshConfirmedRecord(cachedSelected[index], style);
                if (!String.Equals(StyleFingerprint(latest, style), StyleFingerprint(FolioRpc.Object(freshSelected[index]), style), StringComparison.Ordinal))
                    throw new InvalidOperationException("预览期间所选文献已更改或确认状态已过期；未插入引用。请重新预览并确认。");
            }
            state["style"] = style;
            WordDocument.Insert(application, document, selectionStart, selectionEnd, state, citationId, citationText, html);
            status.Text = "引用已插入。文档保存前请检查格式并保存。";
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    private void RefreshDocument()
    {
        try { status.Text = WordDocument.Refresh(application, CurrentStyle(), true, true) ? "文档刷新完成。" : "预览已取消，文档内容保留。"; }
        catch (Exception error) { status.Text = error.Message; }
    }

    private void UpdateButtons()
    {
        bool one = results.SelectedItems.Count == 1;
        preview.Enabled = one;
        bool confirmed = results.SelectedItems.Count > 0;
        foreach (ListViewItem row in results.SelectedItems)
        {
            Dictionary<string, object> record = FolioRpc.Object(row.Tag);
            IDictionary citations = record == null ? null : FolioRpc.Object(record.ContainsKey("citations") ? record["citations"] : null);
            IDictionary citation = citations == null ? null : FolioRpc.Object(citations[CurrentStyle()]);
            confirmed = confirmed && FolioRpc.IsTrue(citation, "confirmed") && !FolioRpc.IsTrue(citation, "stale");
        }
        insert.Enabled = confirmed;
    }

    private static List<string> ToStrings(IList items)
    {
        List<string> values = new List<string>();
        foreach (object item in items) values.Add(FolioRpc.Text(item));
        return values;
    }

    private static List<Dictionary<string, object>> ToRecords(IList values)
    {
        List<Dictionary<string, object>> records = new List<Dictionary<string, object>>();
        foreach (object value in values)
        {
            Dictionary<string, object> record = FolioRpc.Object(value);
            if (record != null) records.Add(record);
        }
        return records;
    }

    private static Dictionary<string, object> GetFreshConfirmedRecord(Dictionary<string, object> cached, string style)
    {
        string id = FolioRpc.Text(cached["id"]);
        Dictionary<string, object> fresh = FolioRpc.Object(FolioRpc.Call(new Dictionary<string, object> {
            { "type", "FOLIO_GET_RECORD" }, { "recordId", id }
        }));
        if (fresh == null || FolioRpc.Text(fresh.ContainsKey("id") ? fresh["id"] : "") != id
            || !fresh.ContainsKey("csl") || !(fresh["csl"] is IDictionary))
            throw new InvalidOperationException("无法重新读取所选文献；请重新搜索后再试。");
        IDictionary cachedCitations = FolioRpc.Object(cached.ContainsKey("citations") ? cached["citations"] : null);
        IDictionary freshCitations = FolioRpc.Object(fresh.ContainsKey("citations") ? fresh["citations"] : null);
        IDictionary cachedStyle = cachedCitations == null ? null : FolioRpc.Object(cachedCitations[style]);
        IDictionary freshStyle = freshCitations == null ? null : FolioRpc.Object(freshCitations[style]);
        string cachedFingerprint = FolioRpc.StringValue(cachedStyle, "fingerprint", "");
        string freshFingerprint = FolioRpc.StringValue(freshStyle, "fingerprint", "");
        if (!FolioRpc.IsTrue(freshStyle, "confirmed") || FolioRpc.IsTrue(freshStyle, "stale")
            || cachedFingerprint.Length == 0 || !String.Equals(cachedFingerprint, freshFingerprint, StringComparison.Ordinal))
            throw new InvalidOperationException("所选文献自搜索或预览确认后已发生变化；为避免插入过期引用，请重新预览并确认。");
        return fresh;
    }

    private static string StyleFingerprint(Dictionary<string, object> record, string style)
    {
        IDictionary citations = FolioRpc.Object(record.ContainsKey("citations") ? record["citations"] : null);
        IDictionary confirmed = citations == null ? null : FolioRpc.Object(citations[style]);
        return FolioRpc.StringValue(confirmed, "fingerprint", "");
    }

    private static string DescribeIncomplete(IList incomplete)
    {
        StringBuilder output = new StringBuilder();
        foreach (object value in incomplete)
        {
            IDictionary item = FolioRpc.Object(value);
            if (item == null) continue;
            IList fields = FolioRpc.List(item.Contains("missing_fields") ? item["missing_fields"] : null);
            output.Append("• ").Append(FolioRpc.Text(item.Contains("id") ? item["id"] : "文献"));
            if (fields != null && fields.Count > 0) output.Append("：").Append(String.Join("、", ToStrings(fields)));
            output.AppendLine();
        }
        return output.ToString().TrimEnd();
    }

    private sealed class FolderChoice
    {
        internal readonly string Id;
        private readonly string name;
        internal FolderChoice(string id, string value) { Id = id; name = value; }
        public override string ToString() { return name; }
    }

    private sealed class StyleChoice
    {
        internal readonly string Id;
        private readonly string name;
        internal StyleChoice(string id, string value) { Id = id; name = value; }
        public override string ToString() { return name; }
    }

}
