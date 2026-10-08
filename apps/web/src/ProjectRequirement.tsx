export function ProjectRequirement({ requirement }: { requirement: string }) {
  const firstLine = requirement.trim().split(/\r?\n/, 1)[0].trim();
  const characters = Array.from(firstLine);
  const title = characters.length > 120 ? characters.slice(0, 120).join('') + '…' : firstLine;
  const hasMore = requirement.trim() !== title;
  return <>
    <h2 className="requirement-title">{title || '项目需求'}</h2>
    {hasMore && <details className="project-requirement-details"><summary>查看完整需求</summary><div className="project-requirement-full">{requirement}</div></details>}
  </>;
}
