import { getCompletionItems } from '@nx-console/language-server/capabilities/code-completion';
import { getDocumentLinks } from '@nx-console/language-server/capabilities/document-links';
import { getHover } from '@nx-console/language-server/capabilities/hover';
import {
  NxChangeWorkspace,
  NxCreateProjectGraphRequest,
  NxGeneratorContextFromPathRequest,
  NxGeneratorContextV2Request,
  NxGeneratorOptionsRequest,
  NxGeneratorOptionsRequestOptions,
  NxGeneratorsRequest,
  NxGeneratorsRequestOptions,
  NxProjectByPathRequest,
  NxProjectFolderTreeRequest,
  NxProjectGraphOutputRequest,
  NxProjectsByPathsRequest,
  NxStartupMessageRequest,
  NxTransformedGeneratorSchemaRequest,
  NxVersionRequest,
  NxWorkspaceRefreshNotification,
  NxWorkspaceRequest,
} from '@nx-console/language-server/types';
import {
  configureJsonLanguageService,
  getJsonLanguageService,
  getLanguageModelCache,
  getSchemaRequestService,
  lspLogger,
  mergeArrays,
  setLspLogger,
} from '@nx-console/language-server/utils';
import { languageServerWatcher } from '@nx-console/language-server/watcher';
import {
  getExecutors,
  getGeneratorContextFromPath,
  getGeneratorOptions,
  getGenerators,
  getProjectByPath,
  getNxVersion,
  nxWorkspace,
  getProjectGraphOutput,
  createProjectGraph,
  getGeneratorContextV2,
  getProjectFolderTree,
  getProjectsByPaths,
  getTransformedGeneratorSchema,
  getStartupMessage,
} from '@nx-console/language-server/workspace';
import { GeneratorSchema } from '@nx-console/shared/generate-ui-types';
import {
  getNxJsonSchema,
  getPackageJsonSchema,
  getProjectJsonSchema,
  getWorkspaceJsonSchema,
} from '@nx-console/shared/json-schema';
import { TaskExecutionSchema } from '@nx-console/shared/schema';
import { formatError } from '@nx-console/shared/utils';
import {
  ClientCapabilities,
  CompletionList,
  TextDocument,
} from 'vscode-json-languageservice';
import {
  createConnection,
  CreateFilesParams,
  DeleteFilesParams,
  FileOperationPatternKind,
  InitializeResult,
  ProposedFeatures,
  ResponseError,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { URI, Utils } from 'vscode-uri';

process.on('unhandledRejection', (e: any) => {
  connection.console.error(formatError(`Unhandled exception`, e));
});

process.on('uncaughtException', (e) => {
  connection.console.error(formatError('Unhandled exception', e));
});

let WORKING_PATH: string | undefined = undefined;
let CLIENT_CAPABILITIES: ClientCapabilities | undefined = undefined;
let unregisterFileWatcher: () => void = () => {
  //noop
};

const workspaceContext = {
  resolveRelativePath: (relativePath: string, resource: string) => {
    const base = resource.substring(0, resource.lastIndexOf('/') + 1);
    return Utils.resolvePath(URI.parse(base), relativePath).toString();
  },
};

const connection = createConnection(ProposedFeatures.all);

// Create a text document manager.
const documents = new TextDocuments(TextDocument);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

connection.onInitialize(async (params) => {
  setLspLogger(connection);

  const { workspacePath } = params.initializationOptions ?? {};
  try {
    WORKING_PATH =
      workspacePath ||
      params.workspaceFolders?.[0]?.uri ||
      params.rootPath ||
      URI.parse(params.rootUri ?? '').fsPath;

    if (!WORKING_PATH) {
      throw 'Unable to determine workspace path';
    }

    CLIENT_CAPABILITIES = params.capabilities;

    configureSchemas(WORKING_PATH, CLIENT_CAPABILITIES);
    unregisterFileWatcher = await languageServerWatcher(
      WORKING_PATH,
      async () => {
        await reconfigure(WORKING_PATH!);
        await connection.sendNotification(
          NxWorkspaceRefreshNotification.method
        );
      }
    );
  } catch (e) {
    lspLogger.log('Unable to get Nx info: ' + e.toString());
  }

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['"', ':'],
      },
      hoverProvider: true,
      documentLinkProvider: {
        resolveProvider: false,
        workDoneProgress: false,
      },
      workspace: {
        fileOperations: {
          didCreate: {
            filters: [
              {
                pattern: {
                  glob: '**/project.json',
                  matches: FileOperationPatternKind.file,
                },
              },
            ],
          },
          didDelete: {
            filters: [
              {
                pattern: {
                  glob: '**/project.json',
                  matches: FileOperationPatternKind.file,
                },
              },
            ],
          },
        },
      },
    },
  };

  return result;
});

connection.onCompletion(async (completionParams) => {
  if (!WORKING_PATH) {
    return new ResponseError(1000, 'Unable to get Nx info: no workspace path');
  }

  const changedDocument = documents.get(completionParams.textDocument.uri);
  if (!changedDocument) {
    return null;
  }

  const { jsonAst, document } = getJsonDocument(changedDocument);

  const completionResults =
    (await getJsonLanguageService()?.doComplete(
      document,
      completionParams.position,
      jsonAst
    )) ?? CompletionList.create([]);

  const schemas = await getJsonLanguageService()?.getMatchingSchemas(
    document,
    jsonAst
  );

  if (!schemas) {
    return completionResults;
  }

  const { nxVersion } = await nxWorkspace(WORKING_PATH, lspLogger);

  const pathItems = await getCompletionItems(
    WORKING_PATH,
    nxVersion,
    jsonAst,
    document,
    schemas,
    completionParams.position
  );
  mergeArrays(completionResults.items, pathItems);

  return completionResults;
});

connection.onHover(async (hoverParams) => {
  const hoverDocument = documents.get(hoverParams.textDocument.uri);

  if (!hoverDocument) {
    return null;
  }

  const { jsonAst, document } = getJsonDocument(hoverDocument);
  return await getHover(hoverParams, jsonAst, document);
});

connection.onDocumentLinks(async (params) => {
  const linkDocument = documents.get(params.textDocument.uri);

  if (!linkDocument) {
    return null;
  }

  const { jsonAst, document } = getJsonDocument(linkDocument);

  const schemas = await getJsonLanguageService()?.getMatchingSchemas(
    document,
    jsonAst
  );

  if (!schemas) {
    return;
  }

  return getDocumentLinks(WORKING_PATH, jsonAst, document, schemas);
});

const jsonDocumentMapper = getLanguageModelCache();

documents.onDidClose((e) => {
  jsonDocumentMapper.onDocumentRemoved(e.document);
});

connection.onShutdown(() => {
  unregisterFileWatcher();
  jsonDocumentMapper.dispose();
});

connection.onRequest(NxWorkspaceRequest, async ({ reset }) => {
  if (!WORKING_PATH) {
    return new ResponseError(1000, 'Unable to get Nx info: no workspace path');
  }

  return nxWorkspace(WORKING_PATH, lspLogger, reset);
});

connection.onRequest(
  NxGeneratorsRequest,
  async (args: { options?: NxGeneratorsRequestOptions }) => {
    if (!WORKING_PATH) {
      return new ResponseError(
        1000,
        'Unable to get Nx info: no workspace path'
      );
    }

    return getGenerators(WORKING_PATH, args.options);
  }
);

connection.onRequest(
  NxGeneratorOptionsRequest,
  async (args: { options: NxGeneratorOptionsRequestOptions }) => {
    if (!WORKING_PATH) {
      return new ResponseError(
        1000,
        'Unable to get Nx info: no workspace path'
      );
    }

    return getGeneratorOptions(
      WORKING_PATH,
      args.options.collection,
      args.options.name,
      args.options.path
    );
  }
);

connection.onRequest(
  NxProjectByPathRequest,
  async (args: { projectPath: string }) => {
    if (!WORKING_PATH) {
      return new ResponseError(
        1000,
        'Unable to get Nx info: no workspace path'
      );
    }
    return getProjectByPath(args.projectPath, WORKING_PATH);
  }
);

connection.onRequest(
  NxProjectsByPathsRequest,
  async (args: { paths: string[] }) => {
    if (!WORKING_PATH) {
      return new ResponseError(
        1000,
        'Unable to get Nx info: no workspace path'
      );
    }
    return getProjectsByPaths(args.paths, WORKING_PATH);
  }
);

// TODO: REMOVE ONCE OLD GENERATE UI IS GONE
connection.onRequest(
  NxGeneratorContextFromPathRequest,
  async (args: { generator?: TaskExecutionSchema; path: string }) => {
    if (!WORKING_PATH) {
      return new ResponseError(
        1000,
        'Unable to get Nx info: no workspace path'
      );
    }
    return getGeneratorContextFromPath(args.generator, args.path, WORKING_PATH);
  }
);

connection.onRequest(
  NxGeneratorContextV2Request,
  async (args: { path: string }) => {
    if (!WORKING_PATH) {
      return new ResponseError(
        1000,
        'Unable to get Nx info: no workspace path'
      );
    }
    return getGeneratorContextV2(args.path, WORKING_PATH);
  }
);

connection.onRequest(NxVersionRequest, async () => {
  if (!WORKING_PATH) {
    return new ResponseError(1000, 'Unable to get Nx info: no workspace path');
  }
  return getNxVersion(WORKING_PATH);
});

connection.onRequest(NxProjectGraphOutputRequest, async () => {
  if (!WORKING_PATH) {
    return new ResponseError(1000, 'Unable to get Nx info: no workspace path');
  }
  return getProjectGraphOutput(WORKING_PATH);
});

connection.onRequest(NxCreateProjectGraphRequest, async () => {
  if (!WORKING_PATH) {
    return new ResponseError(1000, 'Unable to get Nx info: no workspace path');
  }
  try {
    await createProjectGraph(WORKING_PATH, lspLogger);
  } catch (e) {
    return e;
  }
});

connection.onRequest(NxProjectFolderTreeRequest, async () => {
  if (!WORKING_PATH) {
    return new ResponseError(1000, 'Unable to get Nx info: no workspace path');
  }
  return await getProjectFolderTree(WORKING_PATH);
});

connection.onRequest(
  NxTransformedGeneratorSchemaRequest,
  async (schema: GeneratorSchema) => {
    if (!WORKING_PATH) {
      return new ResponseError(
        1000,
        'Unable to get Nx info: no workspace path'
      );
    }
    return getTransformedGeneratorSchema(WORKING_PATH, schema);
  }
);

connection.onRequest(
  NxStartupMessageRequest,
  async (schema: GeneratorSchema) => {
    if (!WORKING_PATH) {
      return new ResponseError(
        1000,
        'Unable to get Nx info: no workspace path'
      );
    }
    return getStartupMessage(WORKING_PATH, schema);
  }
);

connection.onNotification(NxWorkspaceRefreshNotification, async () => {
  if (!WORKING_PATH) {
    return new ResponseError(1001, 'Unable to get Nx info: no workspace path');
  }

  await reconfigure(WORKING_PATH);
});

connection.onNotification(
  'workspace/didCreateFiles',
  async (createdFiles: CreateFilesParams) => {
    if (!createdFiles.files.some((f) => f.uri.endsWith('project.json'))) {
      return;
    }

    if (!WORKING_PATH) {
      return new ResponseError(
        1001,
        'Unable to get Nx info: no workspace path'
      );
    }

    await reconfigure(WORKING_PATH);
  }
);

connection.onNotification(
  'workspace/didDeleteFiles',
  async (deletedFiles: DeleteFilesParams) => {
    if (!deletedFiles.files.some((f) => f.uri.endsWith('project.json'))) {
      return;
    }

    if (!WORKING_PATH) {
      return new ResponseError(
        1001,
        'Unable to get Nx info: no workspace path'
      );
    }

    await reconfigure(WORKING_PATH);
  }
);

connection.onNotification(NxChangeWorkspace, async (workspacePath) => {
  WORKING_PATH = workspacePath;
  await reconfigure(WORKING_PATH);
});

async function reconfigure(workingPath: string) {
  await nxWorkspace(workingPath, lspLogger, true);
  await configureSchemas(workingPath, CLIENT_CAPABILITIES);
}

async function configureSchemas(
  workingPath: string | undefined,
  capabilities: ClientCapabilities | undefined
) {
  if (!workingPath) {
    lspLogger.log('No workspace path provided');
    return;
  }

  const { workspace, nxVersion } = await nxWorkspace(workingPath, lspLogger);
  const collections = await getExecutors(workingPath);
  const workspaceSchema = getWorkspaceJsonSchema(collections);
  const projectSchema = getProjectJsonSchema(
    collections,
    workspace.targetDefaults,
    nxVersion
  );
  const packageSchema = getPackageJsonSchema(nxVersion);

  const nxSchema = getNxJsonSchema(collections, workspace.projects, nxVersion);

  configureJsonLanguageService(
    {
      schemaRequestService: getSchemaRequestService(['file']),
      workspaceContext,
      contributions: [],
      clientCapabilities: capabilities,
    },
    {
      schemas: [
        {
          uri: 'nx://schemas/workspace',
          fileMatch: ['**/workspace.json'],
          schema: workspaceSchema,
        },
        {
          uri: 'nx://schemas/project',
          fileMatch: ['**/project.json'],
          schema: projectSchema,
        },
        {
          uri: 'nx://schemas/package',
          fileMatch: ['**/package.json'],
          schema: packageSchema,
        },
        {
          uri: 'nx://schemas/nx',
          fileMatch: ['**/nx.json'],
          schema: nxSchema,
        },
      ],
    }
  );
}

function getJsonDocument(document: TextDocument) {
  return jsonDocumentMapper.retrieve(document);
}

connection.listen();
