import * as vscode from "vscode";
import { FilePort } from "../core/diff/journal";

/**
 * File access through VS Code so that open editors see agent changes at once
 * and Cmd/Ctrl+Z works on them. Reads prefer the open document (including
 * unsaved edits), so review is always against what the user sees.
 */
export class VsCodeFilePort implements FilePort {
  private openDoc(p: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === p);
  }

  async read(p: string): Promise<string | null> {
    const doc = this.openDoc(p);
    if (doc) return doc.getText();
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(p));
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return null;
    }
  }

  async write(p: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(p);
    const existing = await this.read(p);
    const edit = new vscode.WorkspaceEdit();
    if (existing === null) {
      edit.createFile(uri, { ignoreIfExists: true, contents: new TextEncoder().encode(content) });
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused to create ${p}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const current = doc.getText();
    // Replace only the changed middle so cursors and folding elsewhere are kept.
    let start = 0;
    while (start < current.length && start < content.length && current[start] === content[start]) start++;
    let endCur = current.length;
    let endNew = content.length;
    while (endCur > start && endNew > start && current[endCur - 1] === content[endNew - 1]) {
      endCur--;
      endNew--;
    }
    edit.replace(uri, new vscode.Range(doc.positionAt(start), doc.positionAt(endCur)), content.slice(start, endNew));
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused to edit ${p}`);
    await doc.save();
  }

  async remove(p: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(vscode.Uri.file(p), { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(edit);
  }
}
