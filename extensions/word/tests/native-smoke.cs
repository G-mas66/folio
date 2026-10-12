using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class NativeSmoke
{
    private const int MaxFrame = 1024 * 1024;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static int Main(string[] args)
    {
        if (args.Length != 1) return Fail("Expected the compiled add-in path.");
        string work = Path.Combine(Path.GetTempPath(), "folio-word-native-smoke-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        try
        {
            Assembly assembly = Assembly.LoadFrom(args[0]);
            TestComContract(assembly);
            TestDocumentState(assembly);
            TestRpc(assembly, work);
            TestBibliographySanitizer(assembly);
            Console.WriteLine("Native RPC and bibliography sanitizer smoke passed.");
            return 0;
        }
        catch (Exception error)
        {
            return Fail(error.ToString());
        }
        finally
        {
            try { Directory.Delete(work, true); } catch { }
        }
    }

    private static void TestComContract(Assembly assembly)
    {
        Type connect = assembly.GetType("Connect", true);
        ProgIdAttribute progId = (ProgIdAttribute)Attribute.GetCustomAttribute(connect, typeof(ProgIdAttribute));
        ComDefaultInterfaceAttribute defaultInterface = (ComDefaultInterfaceAttribute)Attribute.GetCustomAttribute(connect, typeof(ComDefaultInterfaceAttribute));
        Assert(progId != null && progId.Value == "Folio.WordAddin", "COM ProgID must match installer registration.");
        Assert(defaultInterface != null && defaultInterface.Value.FullName == "IFolioRibbonCallbacks", "Ribbon callbacks must be exposed as the default dispatch interface.");
        Assert(DispId(connect.Assembly.GetType("IFolioRibbonCallbacks", true).GetMethod("OpenFolio")) == 1, "OpenFolio callback must expose DispId 1.");
        Assert(DispId(connect.Assembly.GetType("IFolioRibbonCallbacks", true).GetMethod("RefreshFolio")) == 2, "RefreshFolio callback must expose DispId 2.");
        Assert(DispId(connect.Assembly.GetType("IRibbonExtensibility", true).GetMethod("GetCustomUI")) == 1, "Ribbon extensibility must expose GetCustomUI.");
    }

    private static int DispId(MethodInfo method)
    {
        DispIdAttribute value = (DispIdAttribute)Attribute.GetCustomAttribute(method, typeof(DispIdAttribute));
        return value == null ? -1 : value.Value;
    }

    private static void TestDocumentState(Assembly assembly)
    {
        Type documentType = assembly.GetType("WordDocument", true);
        MethodInfo load = documentType.GetMethod("LoadState", BindingFlags.Static | BindingFlags.NonPublic);
        MethodInfo save = documentType.GetMethod("SaveState", BindingFlags.Static | BindingFlags.NonPublic);
        SmokeDocument document = new SmokeDocument();
        Dictionary<string, object> original = State("gb-t-7714-2015-numeric", "old", "old-paper");
        save.Invoke(null, new object[] { document, original });

        document.CustomXMLParts.FailNextAdd = true;
        bool addFailed = false;
        try { save.Invoke(null, new object[] { document, State("apa", "new", "new-paper") }); }
        catch (TargetInvocationException) { addFailed = true; }
        Assert(addFailed, "A failed CustomXMLParts.Add must report failure.");
        Assert(document.CustomXMLParts.Count == 1, "A failed state add must leave the previous custom XML part intact.");
        Assert(Text((Dictionary<string, object>)load.Invoke(null, new object[] { document }), "style") == "gb-t-7714-2015-numeric",
            "A failed state add must keep the prior state readable.");

        document.CustomXMLParts.Item(1).FailDelete = true;
        save.Invoke(null, new object[] { document, State("apa", "new", "new-paper") });
        Assert(document.CustomXMLParts.Count == 2, "The smoke fixture must retain an old part when its deletion fails.");
        Dictionary<string, object> latest = (Dictionary<string, object>)load.Invoke(null, new object[] { document });
        Assert(Text(latest, "style") == "apa", "Loading must choose the newest revision even when an old part remains first.");

        SmokeDocument legacy = new SmokeDocument();
        legacy.ContentControls.Add("folio-cite:legacy", "old citation", 1);
        AssertThrows(() => load.Invoke(null, new object[] { legacy }), "Tagged legacy documents must not be treated as empty.");

        SmokeDocument corrupt = new SmokeDocument();
        corrupt.CustomXMLParts.AddExisting("<folio:state xmlns:folio=\"urn:folio:word:citations:v1\" revision=\"1\"><folio:json>{</folio:json></folio:state>");
        AssertThrows(() => load.Invoke(null, new object[] { corrupt }), "Unreadable native state must not be treated as a new empty document.");

        SmokeDocument orderedDocument = new SmokeDocument();
        orderedDocument.ContentControls.Add("folio-cite:second", "second citation", 20);
        orderedDocument.ContentControls.Add("folio-cite:first", "first citation", 40);
        Dictionary<string, object> state = StateWithTwoCitations();
        SmokeWordApplication app = new SmokeWordApplication(orderedDocument, 0, 0);
        MethodInfo reconcile = documentType.GetMethod("ReconcileForInsertion", BindingFlags.Static | BindingFlags.NonPublic);
        object[] reconcileArguments = { app, orderedDocument, state, 0, 0 };
        int insertionIndex = Convert.ToInt32(reconcile.Invoke(null, reconcileArguments));
        MethodInfo newCitation = documentType.GetMethod("NewCitation", BindingFlags.Static | BindingFlags.NonPublic);
        string newRecordId = "new-paper";
        ArrayList selected = new ArrayList { new Dictionary<string, object> {
            { "id", newRecordId }, { "csl", new Dictionary<string, object> { { "id", newRecordId }, { "type", "book" }, { "title", "New title" } } }
        } };
        object[] citationArguments = { state, selected, "", insertionIndex, null };
        newCitation.Invoke(null, citationArguments);
        string insertedId = Convert.ToString(citationArguments[4]);
        IList citations = (IList)state["citations"];
        IDictionary first = (IDictionary)citations[0];
        Assert(insertedId.Length > 0 && Text((Dictionary<string, object>)first, "id") == insertedId,
            "A front insertion must return the ID of the citation actually inserted at the front.");
        MethodInfo rendererState = documentType.GetMethod("RendererState", BindingFlags.Static | BindingFlags.NonPublic);
        Dictionary<string, object> renderer = (Dictionary<string, object>)rendererState.Invoke(null, new object[] { state, "gb-t-7714-2015-numeric" });
        IList renderedCitations = (IList)renderer["citations"];
        Assert(Text((Dictionary<string, object>)renderedCitations[0], "id") == insertedId,
            "The rendered preview order and inserted citation ID must match the Word selection position.");
    }

    private static Dictionary<string, object> State(string style, string citationId, string itemId)
    {
        Dictionary<string, object> item = new Dictionary<string, object> { { "id", itemId }, { "type", "book" }, { "title", itemId } };
        Dictionary<string, object> citationItem = new Dictionary<string, object> { { "id", itemId } };
        Dictionary<string, object> citation = new Dictionary<string, object> { { "id", citationId }, { "items", new ArrayList { citationItem } } };
        return new Dictionary<string, object> {
            { "version", 1 }, { "style", style }, { "items", new Dictionary<string, object> { { itemId, item } } },
            { "citations", new ArrayList { citation } }, { "bibliographyText", "" }
        };
    }

    private static Dictionary<string, object> StateWithTwoCitations()
    {
        Dictionary<string, object> firstItem = new Dictionary<string, object> { { "id", "first-paper" }, { "type", "book" }, { "title", "First" } };
        Dictionary<string, object> secondItem = new Dictionary<string, object> { { "id", "second-paper" }, { "type", "book" }, { "title", "Second" } };
        Dictionary<string, object> first = new Dictionary<string, object> { { "id", "first" }, { "items", new ArrayList { new Dictionary<string, object> { { "id", "first-paper" } } } } };
        Dictionary<string, object> second = new Dictionary<string, object> { { "id", "second" }, { "items", new ArrayList { new Dictionary<string, object> { { "id", "second-paper" } } } } };
        return new Dictionary<string, object> {
            { "version", 1 }, { "style", "gb-t-7714-2015-numeric" },
            { "items", new Dictionary<string, object> { { "first-paper", firstItem }, { "second-paper", secondItem } } },
            { "citations", new ArrayList { first, second } }, { "bibliographyText", "" }
        };
    }

    private static void AssertThrows(Action action, string message)
    {
        bool threw = false;
        try { action(); } catch { threw = true; }
        Assert(threw, message);
    }

    private static void TestRpc(Assembly assembly, string work)
    {
        string pipeName = "folio-word-smoke-" + Guid.NewGuid().ToString("N");
        string secret = new string('a', 64);
        string secretPath = Path.Combine(work, "bridge.secret");
        File.WriteAllText(secretPath, secret, new UTF8Encoding(false));
        Task serverTask = Task.Factory.StartNew(delegate
        {
            using (NamedPipeServerStream server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None))
            {
                server.WaitForConnection();
                Dictionary<string, object> auth = ReadFrame(server);
                Assert(Text(auth, "type") == "FOLIO_NATIVE_AUTH", "RPC must authenticate before requests.");
                Assert(Text(auth, "secret") == secret, "RPC must send the local secret.");
                WriteFrame(server, new Dictionary<string, object> {
                    { "id", "native-auth" }, { "ok", true },
                    { "result", new Dictionary<string, object> { { "authenticated", true } } }
                });
                Dictionary<string, object> request = ReadFrame(server);
                Assert(Text(request, "type") == "FOLIO_SEARCH", "RPC must send the requested operation.");
                Assert(Text(request, "id").Length > 0 && Text(request, "id") != "native-auth", "RPC must add a correlation id.");
                WriteFrame(server, new Dictionary<string, object> {
                    { "id", request["id"] }, { "ok", true },
                    { "result", new Dictionary<string, object> { { "items", new object[0] }, { "total", 0 } } }
                });
            }
        });

        Type rpc = assembly.GetType("FolioRpc", true);
        MethodInfo call = rpc.GetMethod("Call", BindingFlags.Static | BindingFlags.NonPublic);
        Dictionary<string, object> payload = new Dictionary<string, object> { { "type", "FOLIO_SEARCH" }, { "query", "smoke" } };
        object result;
        try { result = call.Invoke(null, new object[] { payload, secretPath, pipeName }); }
        catch (TargetInvocationException error) { throw error.InnerException ?? error; }
        serverTask.Wait(5000);
        if (!serverTask.IsCompleted) throw new InvalidOperationException("RPC server did not finish.");
        Dictionary<string, object> parsed = result as Dictionary<string, object>;
        Assert(parsed != null && parsed.ContainsKey("items"), "RPC must return the result payload.");
        Assert(Convert.ToInt32(parsed["total"]) == 0, "RPC must preserve the returned total.");
    }

    private static void TestBibliographySanitizer(Assembly assembly)
    {
        Type document = assembly.GetType("WordDocument", true);
        MethodInfo sanitize = document.GetMethod("SafeBibliographyHtml", BindingFlags.Static | BindingFlags.NonPublic);
        Dictionary<string, object> bibliography = new Dictionary<string, object> {
            { "parameters", new Dictionary<string, object> { { "hangingindent", "true" } } },
            { "entries", new object[] {
                "<div class=\"csl-entry\"><div class=\"csl-left-margin\">[1]</div><div class=\"csl-right-inline\">Author. <i>Quoted title</i>.</div></div>",
                "<div class=\"csl-entry\">Second author. <i>Journal title</i>.</div>"
            } }
        };
        Dictionary<string, object> rendered = new Dictionary<string, object> { { "bibliography", bibliography } };
        string html = (string)sanitize.Invoke(null, new object[] { rendered });
        Assert(Regex.Matches(html, "<p\\b").Count == 2, "Each bibliography entry must import as one paragraph.");
        Assert(!Regex.IsMatch(html, "</?div\\b", RegexOptions.IgnoreCase), "CSL div wrappers must not split entries in Word.");
        Assert(html.Contains("[1]&nbsp;&nbsp;Author. <i>Quoted title</i>."), "GB left-margin labels and inline content must remain together.");
        Assert(html.Contains("<i>Journal title</i>"), "APA italics must survive sanitizing.");
    }

    private static Dictionary<string, object> ReadFrame(Stream stream)
    {
        byte[] header = ReadExact(stream, 4);
        int length = BitConverter.ToInt32(header, 0);
        Assert(length > 0 && length <= MaxFrame, "The pipe frame length must be bounded.");
        return Json.DeserializeObject(Encoding.UTF8.GetString(ReadExact(stream, length))) as Dictionary<string, object>;
    }

    private static void WriteFrame(Stream stream, object value)
    {
        byte[] body = Encoding.UTF8.GetBytes(Json.Serialize(value));
        byte[] header = BitConverter.GetBytes(body.Length);
        stream.Write(header, 0, header.Length);
        stream.Write(body, 0, body.Length);
        stream.Flush();
    }

    private static byte[] ReadExact(Stream stream, int length)
    {
        byte[] bytes = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int count = stream.Read(bytes, offset, length - offset);
            if (count <= 0) throw new EndOfStreamException();
            offset += count;
        }
        return bytes;
    }

    private static string Text(IDictionary<string, object> value, string key)
    {
        return value.ContainsKey(key) && value[key] != null ? Convert.ToString(value[key]) : "";
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine(message);
        return 1;
    }
}

public sealed class SmokeDocument
{
    public SmokeCustomXmlParts CustomXMLParts { get; private set; }
    public SmokeContentControls ContentControls { get; private set; }

    public SmokeDocument()
    {
        CustomXMLParts = new SmokeCustomXmlParts();
        ContentControls = new SmokeContentControls(this);
    }
}

public sealed class SmokeCustomXmlParts
{
    private readonly List<SmokePart> parts = new List<SmokePart>();
    public bool FailNextAdd;
    public int Count { get { return parts.Count; } }

    public SmokeCustomXmlParts SelectByNamespace(string xmlNamespace) { return this; }
    public SmokePart Item(int oneBased) { return parts[oneBased - 1]; }

    public SmokePart Add(string xml)
    {
        if (FailNextAdd)
        {
            FailNextAdd = false;
            throw new InvalidOperationException("simulated CustomXMLParts.Add failure");
        }
        SmokePart part = new SmokePart(this, xml);
        parts.Add(part);
        return part;
    }

    public SmokePart AddExisting(string xml)
    {
        SmokePart part = new SmokePart(this, xml);
        parts.Add(part);
        return part;
    }

    internal void Remove(SmokePart part) { parts.Remove(part); }
}

public sealed class SmokePart
{
    private readonly SmokeCustomXmlParts owner;
    public string XML { get; private set; }
    public bool FailDelete;

    internal SmokePart(SmokeCustomXmlParts collection, string xml)
    {
        owner = collection;
        XML = xml;
    }

    public void Delete()
    {
        if (FailDelete) throw new InvalidOperationException("simulated CustomXMLPart.Delete failure");
        owner.Remove(this);
    }
}

public sealed class SmokeContentControls
{
    private readonly SmokeDocument document;
    private readonly List<SmokeContentControl> controls = new List<SmokeContentControl>();
    public int Count { get { return controls.Count; } }

    public SmokeContentControls(SmokeDocument owner) { document = owner; }
    public SmokeContentControl Item(int oneBased) { return controls[oneBased - 1]; }

    public SmokeContentControl Add(string tag, string text, int start)
    {
        SmokeContentControl control = new SmokeContentControl(document, tag, text, start);
        controls.Add(control);
        return control;
    }
}

public sealed class SmokeContentControl
{
    public string Tag { get; set; }
    public string Title { get; set; }
    public SmokeRange Range { get; private set; }

    public SmokeContentControl(SmokeDocument document, string tag, string text, int start)
    {
        Tag = tag;
        Range = new SmokeRange(document, text, start, start + (text == null ? 0 : text.Length));
    }
}

public sealed class SmokeRange
{
    public int Start { get; set; }
    public int End { get; set; }
    public string Text { get; set; }
    public SmokeDocument Document { get; private set; }

    public SmokeRange(SmokeDocument document, string text, int start, int end)
    {
        Document = document;
        Text = text;
        Start = start;
        End = end;
    }
}

public sealed class SmokeWordApplication
{
    public SmokeSelection Selection { get; private set; }
    public SmokeDocument ActiveDocument { get; private set; }

    public SmokeWordApplication(SmokeDocument document, int start, int end)
    {
        ActiveDocument = document;
        Selection = new SmokeSelection(document, start, end);
    }
}

public sealed class SmokeSelection
{
    public SmokeRange Range { get; private set; }
    public SmokeSelection(SmokeDocument document, int start, int end)
    {
        Range = new SmokeRange(document, "", start, end);
    }
}
