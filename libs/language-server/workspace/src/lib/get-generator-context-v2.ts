import { GeneratorContext } from '@nx-console/shared/generate-ui-types';
import { existsSync, lstatSync } from 'fs';
import { normalize, parse } from 'path';
import { getProjectByPath } from './get-project-by-path';
import { nxWorkspace } from './workspace';

export async function getGeneratorContextV2(
  path: string,
  workspacePath: string
): Promise<GeneratorContext> {
  const normalizedPath = normalize(path);
  const project = await getProjectByPath(normalizedPath, workspacePath);

  const projectName = (project && project.name) || undefined;

  const { workspaceLayout } = await nxWorkspace(workspacePath);
  const directory = getNormalizedDirectory(
    normalizedPath,
    workspaceLayout,
    workspacePath
  );

  return {
    project: projectName,
    directory,
  };
}

function getNormalizedDirectory(
  path: string,
  { appsDir, libsDir }: { appsDir?: string; libsDir?: string },
  workspacePath: string
) {
  let dir: string | undefined = undefined;
  if (existsSync(path)) {
    if (lstatSync(path).isDirectory()) {
      dir = path;
    } else {
      dir = parse(path).dir;
    }
  }

  if (!dir) {
    return;
  }

  dir = dir
    .replace(normalize(workspacePath), '')
    .replace(/\\/g, '/')
    .replace(/^\//, '');

  if (appsDir && dir.startsWith(appsDir)) {
    dir = dir.replace(appsDir, '').replace(/^\//, '');
  }
  if (libsDir && dir.startsWith(libsDir)) {
    dir = dir.replace(libsDir, '').replace(/^\//, '');
  }

  // return the directory if the path is a file
  return dir;
}
