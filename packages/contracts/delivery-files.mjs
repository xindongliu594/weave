/** Every other writer must precede the selected final producer. */
export function conflictingDeliveryWriters(tasks,producerId,path){
 const byId=new Map(tasks.map(task=>[task.id,task])),upstream=new Set(),pending=[...(byId.get(producerId)?.dependencies??[])];
 while(pending.length){const id=pending.pop();if(upstream.has(id))continue;upstream.add(id);pending.push(...(byId.get(id)?.dependencies??[]));}
 return tasks.filter(task=>task.id!==producerId&&!upstream.has(task.id)&&task.outputs?.some(file=>file.path===path)).map(task=>task.id);
}
