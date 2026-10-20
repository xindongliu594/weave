/** Pure planner contracts. A scope hash is integrity metadata, not authorization or an execution receipt. */
export type TaskWorkspaceFile = {path:string;content:string};
export type TaskWorkspaceManifestEntry = {path:string;size:number;sha256:string};
export type TaskWorkspaceOrigin = {path:string;runId:string;taskId:string;attemptId:string;acceptedRevision:string;checkpointId?:string};
export type TaskWorkspaceBinding = {
 projectId:string;planVersion:number;runId:string;taskId:string;attemptId:string;assigneeId:string;generation:number;
 contractHash:string;permissionHash:string;
 backend:{kind:'openshell';version:'0.1.2';image:string;policyHash:string};
};
export type CreateTaskWorkspaceOptions = {
 binding:TaskWorkspaceBinding;readPaths:string[];writePaths:string[];canonicalFiles:TaskWorkspaceFile[];origins:TaskWorkspaceOrigin[];
};
export type TaskWorkspace = {
 profile:'weiwu-task-workspace-v1';binding:TaskWorkspaceBinding;readPaths:string[];writePaths:string[];
 importedFiles:TaskWorkspaceFile[];inputManifest:(TaskWorkspaceManifestEntry&{origin:TaskWorkspaceOrigin})[];
 outputBaseline:{path:string;sha256:string|null}[];
 /** Metadata for all canonical files, including those whose contents are not authorized for import. */
 baseCanonicalManifest:TaskWorkspaceManifestEntry[];baseCanonicalRevision:string;scopeHash:string;
};
export type TaskWorkspaceChange = {path:string;beforeSha256:string|null;afterSha256:string;size:number;content:string};
export type TaskWorkspaceMergePlan = {
 mergedFiles:TaskWorkspaceFile[];beforeRevision:string;afterRevision:string;scopeHash:string;delta:TaskWorkspaceChange[];
};
/** Runtime functions are exported by apps/desktop/task-workspace.cjs; these types do not execute or commit a plan. */
export type TaskWorkspacePlanner = {
 createTaskWorkspace:(options:CreateTaskWorkspaceOptions)=>TaskWorkspace;
 validateTaskExport:(workspace:TaskWorkspace,exportedFiles:TaskWorkspaceFile[])=>TaskWorkspaceChange[];
 planTaskMerge:(workspace:TaskWorkspace,exportedFiles:TaskWorkspaceFile[],currentCanonicalFiles:TaskWorkspaceFile[])=>TaskWorkspaceMergePlan;
};
