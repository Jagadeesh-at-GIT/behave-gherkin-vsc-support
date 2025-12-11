// src/extension.ts
import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { promisify } from "util";

const execFile = promisify(cp.execFile);

const PY_CLI_REL = path.posix.join("tools", "find_step.py");
const KEYWORDS = ["Feature", "Scenario", "Given", "When", "Then", "And", "But"];
const GHERKIN_IDS = ["feature", "gherkin"];

type StepDef = {
  file: string;
  line: number;
  raw: string;
  normalized: string;
  keyword?: string;
};

async function findPython(): Promise<string | null> {
  for (const c of ["python3", "python"]) {
    try {
      await execFile(c, ["--version"], { timeout: 2000 });
      return c;
    } catch {}
  }
  return null;
}

async function runPythonCli(args: string[], cwd: string): Promise<any> {
  const py = await findPython();
  if (!py) throw new Error("Python not found (python3 or python required on PATH)");
  const cli = path.join(cwd, PY_CLI_REL);
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(cli));
  } catch {
    throw new Error(`CLI not found at ${cli}. Ensure tools/find_step.py exists in workspace root.`);
  }
  try {
    const { stdout } = await execFile(py, [cli, ...args], { cwd, timeout: 15000 });
    return JSON.parse(stdout || "null");
  } catch (err: any) {
    throw new Error(err.stderr || err.message || String(err));
  }
}

function normalizeGherkin(line: string): string {
  let t = line.trim();
  for (const k of KEYWORDS) {
    const p = new RegExp("^" + k + "\\s+", "i");
    if (p.test(t)) { t = t.replace(p, ""); break; }
  }
  t = t.replace(/"[^"]*"/g, '"{}"');
  return t.trim();
}

export async function activate(context: vscode.ExtensionContext) {
  const diagCollection = vscode.languages.createDiagnosticCollection("behave-gherkin");
  context.subscriptions.push(diagCollection);

  let stepIndex: StepDef[] = [];

  async function reindex() {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;
    try {
      const res = await runPythonCli(["--index"], ws.uri.fsPath);
      stepIndex = Array.isArray(res) ? res : [];
    } catch (e: any) {
      vscode.window.showErrorMessage("Index failed: " + (e.message || e));
      stepIndex = [];
    }
    await updateWorkspaceDiagnostics();
  }

  async function findStepForLine(line: string): Promise<StepDef | null> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return null;
    try {
      const res = await runPythonCli(["--line", line], ws.uri.fsPath);
      return res || null;
    } catch (e:any) {
      console.error("findStepForLine error:", e);
      return null;
    }
  }

  async function updateWorkspaceDiagnostics() {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;
    try {
      const missing = await runPythonCli(["--undefined"], ws.uri.fsPath);
      diagCollection.clear();
      if (Array.isArray(missing)) {
        const map = new Map<string, vscode.Diagnostic[]>();
        for (const m of missing) {
          const uri = vscode.Uri.file(m.feature_file);
          const range = new vscode.Range(m.line - 1, 0, m.line - 1, Math.min(m.text.length, 300));
          const diag = new vscode.Diagnostic(range, "Step definition not found", vscode.DiagnosticSeverity.Warning);
          diag.source = "behave-gherkin";
          const arr = map.get(uri.toString()) || [];
          arr.push(diag);
          map.set(uri.toString(), arr);
        }
        for (const [k, arr] of map.entries()) {
          diagCollection.set(vscode.Uri.parse(k), arr);
        }
      }
    } catch (e:any) {
      console.error("Diagnostics update failed:", e);
    }
  }

  await reindex();

  const stepsGlob = "features/steps/**/*.py";
  const featuresGlob = "features/**/*.feature";
  const w1 = vscode.workspace.createFileSystemWatcher(stepsGlob);
  const w2 = vscode.workspace.createFileSystemWatcher(featuresGlob);
  [w1, w2].forEach(w => {
    context.subscriptions.push(w);
    w.onDidCreate(reindex);
    w.onDidChange(reindex);
    w.onDidDelete(reindex);
  });

  const defProvider: vscode.DefinitionProvider = {
    provideDefinition: async (doc, pos) => {
      const lineText = doc.lineAt(pos.line).text;
      if (!/\b(Given|When|Then|And|But)\b/.test(lineText)) return null;
      const found = await findStepForLine(lineText);
      if (!found) return null;
      const uri = vscode.Uri.file(found.file);
      return new vscode.Location(uri, new vscode.Position(found.line - 1, 0));
    }
  };
  context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: "feature" }, defProvider));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: "gherkin" }, defProvider));

  class CreateStepCodeActionProvider implements vscode.CodeActionProvider {
    public async provideCodeActions(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[] | undefined> {
      const line = document.lineAt(range.start.line).text;
      if (!/\b(Given|When|Then|And|But)\b/.test(line)) return;
      const norm = normalizeGherkin(line);
      if (stepIndex.some(s => s.normalized === norm)) return;
      const action = new vscode.CodeAction("Create step definition...", vscode.CodeActionKind.QuickFix);
      action.command = { command: "behaveGherkin.createStepDefinition", title: "Create step", arguments: [document.uri, range.start.line] };
      return [action];
    }
  }
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ language: "feature" }, new CreateStepCodeActionProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));

  context.subscriptions.push(vscode.commands.registerCommand("behaveGherkin.goToStepDefinition", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage("No active editor"); return; }
    const lineText = editor.document.lineAt(editor.selection.active.line).text;
    const found = await findStepForLine(lineText);
    if (!found) { vscode.window.showInformationMessage("No matching step definition found"); return; }
    const uri = vscode.Uri.file(found.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(found.line - 1, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("behaveGherkin.createStepDefinition", async (featureUri?: vscode.Uri, lineNum?: number) => {
    try {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) { vscode.window.showErrorMessage("Open a workspace folder first"); return; }

      let featureLine = "";
      if (featureUri && typeof lineNum === "number") {
        const doc = await vscode.workspace.openTextDocument(featureUri);
        featureLine = doc.lineAt(lineNum).text.trim();
      } else if (vscode.window.activeTextEditor) {
        featureLine = vscode.window.activeTextEditor.document.lineAt(vscode.window.activeTextEditor.selection.active.line).text.trim();
      } else {
        vscode.window.showErrorMessage("No feature line selected");
        return;
      }

      const files = await vscode.workspace.findFiles("**/features/steps/**/*.py", "**/node_modules/**", 100);
      const quickItems: vscode.QuickPickItem[] = [
        ...files.map(f => ({ label: path.relative(ws.uri.fsPath, f.fsPath), description: f.fsPath })),
        { label: "<Create new file>", description: "Create a new steps file (e.g. features/steps/new_steps.py)" }
      ];
      const pick = await vscode.window.showQuickPick(quickItems, { placeHolder: "Select steps file to add the generated step" });
      if (!pick) return;

      let targetUri: vscode.Uri;
      if (pick.label === "<Create new file>") {
        const input = await vscode.window.showInputBox({ prompt: "Enter relative path for new steps file", value: "features/steps/steps_generated.py" });
        if (!input) return;
        targetUri = ws.uri.with({ path: path.posix.join(ws.uri.path, input) });
      } else {
        targetUri = vscode.Uri.file((pick as any).description);
      }

      const paramMatches = Array.from(featureLine.matchAll(/"([^"]*)"/g));
      const params = paramMatches.map((_, i) => `param${i+1}`);
      let template = featureLine;
      let idx = 0;
      template = template.replace(/"([^"]*)"/g, () => {
        idx++; return `"{${params[idx-1]}}"`;
      });
      const kwMatch = /^\s*(Given|When|Then|And|But)\b/i.exec(featureLine);
      const kw = (kwMatch ? kwMatch[1] : "when").toLowerCase();

      const snippet = `@${kw}('${template}')
def step_impl(context${params.length ? ", " + params.join(", ") : ""}):
    \"\"\"Auto-generated step for: ${featureLine}\"\"\"
    # TODO: implement step
    raise NotImplementedError("Step not implemented")
\n`;

      try {
        await vscode.workspace.fs.stat(targetUri);
        const doc2 = await vscode.workspace.openTextDocument(targetUri);
        const edit = new vscode.WorkspaceEdit();
        const end = new vscode.Position(doc2.lineCount, 0);
        edit.insert(targetUri, end, "\n" + snippet);
        await vscode.workspace.applyEdit(edit);
        await doc2.save();
      } catch {
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from("# Generated behave steps\n\n" + snippet, "utf8"));
      }

      vscode.window.showInformationMessage(`Step created/updated in ${path.relative(ws.uri.fsPath, targetUri.fsPath)}`);
      await reindex();
    } catch (e:any) {
      vscode.window.showErrorMessage("Create step failed: " + (e.message || e));
    }
  }));

  vscode.workspace.onDidOpenTextDocument(doc => {
    if (GHERKIN_IDS.includes(doc.languageId)) updateDocDiagnostics(doc);
  });
  vscode.workspace.onDidChangeTextDocument(ev => {
    if (GHERKIN_IDS.includes(ev.document.languageId)) updateDocDiagnostics(ev.document);
  });

  function updateDocDiagnostics(doc: vscode.TextDocument) {
    if (!doc) return;
    const diagnostics: vscode.Diagnostic[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;
      if (!/\b(Given|When|Then|And|But)\b/.test(text)) continue;
      const normalized = normalizeGherkin(text);
      const matched = stepIndex.find(s => s.normalized === normalized);
      if (!matched) {
        const range = new vscode.Range(i, 0, i, Math.min(text.length, 300));
        diagnostics.push(new vscode.Diagnostic(range, "Step definition not found", vscode.DiagnosticSeverity.Warning));
      }
    }
    diagCollection.set(doc.uri, diagnostics);
  }

  const legend = new vscode.SemanticTokensLegend(["keyword", "string"], []);
  context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider({ language: "feature" }, new (class implements vscode.DocumentSemanticTokensProvider {
    async provideDocumentSemanticTokens(document: vscode.TextDocument): Promise<vscode.SemanticTokens> {
      const builder = new vscode.SemanticTokensBuilder(legend);
      for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i).text;
        const kw = /^\s*(Feature|Scenario|Given|When|Then|And|But)\b/.exec(line);
        if (kw) {
          const s = line.indexOf(kw[1]);
          builder.push(i, s, kw[1].length, 0, 0); // keyword
        }
        for (const m of line.matchAll(/"[^"]*"/g)) {
          const s = m.index ?? -1;
          if (s >= 0) builder.push(i, s, m[0].length, 1, 0); // string param
        }
      }
      return builder.build();
    }
  })(), legend));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(reindex));
}

export function deactivate() {}
