/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TextDocument } from 'vscode-languageserver-textdocument';
import { JSONDocument } from './jsonParser07';
import { Document, isPair, isScalar, LineCounter, visit, YAMLError } from 'yaml';
import { ASTNode } from '../jsonASTTypes';
import { defaultOptions, parse as parseYAML, ParserOptions } from './yamlParser07';
import { ErrorCode } from 'vscode-json-languageservice';
import { Node } from 'yaml';
import { convertAST } from './ast-converter';
import { YAMLDocDiagnostic } from '../utils/parseUtils';
import { isArrayEqual } from '../utils/arrUtils';
import { getParent } from '../utils/astUtils';
import { TextBuffer } from '../utils/textBuffer';
import { getIndentation } from '../utils/strings';
import { Token } from 'yaml/dist/parse/cst';

/**
 * These documents are collected into a final YAMLDocument
 * and passed to the `parseYAML` caller.
 */
export class SingleYAMLDocument extends JSONDocument {
  private lineCounter: LineCounter;
  private _internalDocument: Document;
  public root: ASTNode;
  public currentDocIndex: number;
  private _lineComments: string[];

  constructor(lineCounter?: LineCounter) {
    super(null, []);
    this.lineCounter = lineCounter;
  }

  private collectLineComments(): void {
    this._lineComments = [];
    if (this._internalDocument.commentBefore) {
      const comments = this._internalDocument.commentBefore.split('\n');
      comments.forEach((comment) => this._lineComments.push(`#${comment}`));
    }
    visit(this.internalDocument, (_key, node: Node) => {
      if (node?.commentBefore) {
        const comments = node?.commentBefore.split('\n');
        comments.forEach((comment) => this._lineComments.push(`#${comment}`));
      }

      if (node?.comment) {
        this._lineComments.push(`#${node.comment}`);
      }
    });

    if (this._internalDocument.comment) {
      this._lineComments.push(`#${this._internalDocument.comment}`);
    }
  }

  set internalDocument(document: Document) {
    this._internalDocument = document;
    this.root = convertAST(null, this._internalDocument.contents as Node, this._internalDocument, this.lineCounter);
  }

  get internalDocument(): Document {
    return this._internalDocument;
  }

  get lineComments(): string[] {
    if (!this._lineComments) {
      this.collectLineComments();
    }
    return this._lineComments;
  }
  set lineComments(val: string[]) {
    this._lineComments = val;
  }
  get errors(): YAMLDocDiagnostic[] {
    return this.internalDocument.errors.map(YAMLErrorToYamlDocDiagnostics);
  }
  get warnings(): YAMLDocDiagnostic[] {
    return this.internalDocument.warnings.map(YAMLErrorToYamlDocDiagnostics);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
  public getSchemas(schema: any, doc: any, node: any): any[] {
    const matchingSchemas = [];
    doc.validate(schema, matchingSchemas, node.start);
    return matchingSchemas;
  }

  getNodeFromPosition(positionOffset: number, textBuffer: TextBuffer): [Node | undefined, boolean] {
    const position = textBuffer.getPosition(positionOffset);
    const lineContent = textBuffer.getLineContent(position.line);
    if (lineContent.trim().length === 0) {
      return [this.findClosestNode(positionOffset, textBuffer), true];
    }

    let closestNode: Node;
    visit(this.internalDocument, (key, node: Node) => {
      if (!node) {
        return;
      }
      const range = node.range;
      if (!range) {
        return;
      }

      if (range[0] <= positionOffset && range[1] >= positionOffset) {
        closestNode = node;
      } else {
        return visit.SKIP;
      }
    });

    return [closestNode, false];
  }

  findClosestNode(offset: number, textBuffer: TextBuffer): Node {
    let offsetDiff = this.internalDocument.range[2];
    let maxOffset = this.internalDocument.range[0];
    let closestNode: Node;
    visit(this.internalDocument, (key, node: Node) => {
      if (!node) {
        return;
      }
      const range = node.range;
      if (!range) {
        return;
      }
      const diff = Math.abs(range[2] - offset);
      if (maxOffset <= range[0] && diff <= offsetDiff) {
        offsetDiff = diff;
        maxOffset = range[0];
        closestNode = node;
      }
    });

    const position = textBuffer.getPosition(offset);
    const lineContent = textBuffer.getLineContent(position.line);
    const indentation = getIndentation(lineContent, position.character);

    if (isScalar(closestNode) && closestNode.value === null) {
      return closestNode;
    }

    if (indentation === position.character) {
      closestNode = this.getProperParentByIndentation(indentation, closestNode, textBuffer);
    }

    return closestNode;
  }

  private getProperParentByIndentation(indentation: number, node: Node, textBuffer: TextBuffer): Node {
    if (!node) {
      return this.internalDocument.contents as Node;
    }
    if (node.range) {
      const position = textBuffer.getPosition(node.range[0]);
      if (position.character !== indentation && position.character > 0) {
        const parent = this.getParent(node);
        if (parent) {
          return this.getProperParentByIndentation(indentation, parent, textBuffer);
        }
      } else {
        return node;
      }
    } else if (isPair(node)) {
      const parent = this.getParent(node);
      return this.getProperParentByIndentation(indentation, parent, textBuffer);
    }
    return node;
  }

  getParent(node: Node): Node | undefined {
    return getParent(this.internalDocument, node);
  }
}

/**
 * Contains the SingleYAMLDocuments, to be passed
 * to the `parseYAML` caller.
 */
export class YAMLDocument {
  documents: SingleYAMLDocument[];
  tokens: Token[];

  private errors: YAMLDocDiagnostic[];
  private warnings: YAMLDocDiagnostic[];

  constructor(documents: SingleYAMLDocument[], tokens: Token[]) {
    this.documents = documents;
    this.tokens = tokens;
    this.errors = [];
    this.warnings = [];
  }
}

interface YamlCachedDocument {
  version: number;
  parserOptions: ParserOptions;
  document: YAMLDocument;
}
export class YamlDocuments {
  // a mapping of URIs to cached documents
  private cache = new Map<string, YamlCachedDocument>();

  /**
   * Get cached YAMLDocument
   * @param document TextDocument to parse
   * @param customTags YAML custom tags
   * @param addRootObject if true and document is empty add empty object {} to force schema usage
   * @returns the YAMLDocument
   */
  getYamlDocument(document: TextDocument, parserOptions?: ParserOptions, addRootObject = false): YAMLDocument {
    this.ensureCache(document, parserOptions ?? defaultOptions, addRootObject);
    return this.cache.get(document.uri).document;
  }

  /**
   * For test purpose only!
   */
  clear(): void {
    this.cache.clear();
  }

  private ensureCache(document: TextDocument, parserOptions: ParserOptions, addRootObject: boolean): void {
    const key = document.uri;
    if (!this.cache.has(key)) {
      this.cache.set(key, { version: -1, document: new YAMLDocument([], []), parserOptions: defaultOptions });
    }
    const cacheEntry = this.cache.get(key);
    if (
      cacheEntry.version !== document.version ||
      (parserOptions.customTags && !isArrayEqual(cacheEntry.parserOptions.customTags, parserOptions.customTags))
    ) {
      let text = document.getText();
      // if text is contains only whitespace wrap all text in object to force schema selection
      if (addRootObject && !/\S/.test(text)) {
        text = `{${text}}`;
      }
      const doc = parseYAML(text, parserOptions);
      cacheEntry.document = doc;
      cacheEntry.version = document.version;
      cacheEntry.parserOptions = parserOptions;
    }
  }
}

export const yamlDocumentsCache = new YamlDocuments();

function YAMLErrorToYamlDocDiagnostics(error: YAMLError): YAMLDocDiagnostic {
  return {
    message: error.message,
    location: {
      start: error.pos[0],
      end: error.pos[1],
      toLineEnd: true,
    },
    severity: 1,
    code: ErrorCode.Undefined,
  };
}
