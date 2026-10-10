import {createHash} from 'node:crypto';
import type pg from 'pg';

export async function planningConversation(db:Pick<pg.PoolClient,'query'>,projectId:string,version:number){
 const rows=(await db.query<{id:string;project_version:number;content:string;reply:string|null;status:string;total_count:string;pending_count:string}>("SELECT id,project_version,content,reply,status,count(*) OVER() AS total_count,count(*) FILTER(WHERE status IN ('waiting','replying')) OVER() AS pending_count FROM manager_messages WHERE project_id=$1 AND project_version<=$2 ORDER BY created_at DESC,id DESC LIMIT 12",[projectId,version])).rows.reverse();
 const sha256=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
 const messages=rows.map(row=>({id:row.id,sourceVersion:row.project_version,user:row.content,...(row.reply?{managerReply:row.reply.slice(0,1000),replyTruncated:row.reply.length>1000}:{})}));
 while(messages.length>1&&JSON.stringify(messages).length>16000)messages.shift();
 const count=Number(rows[0]?.total_count??0),pendingCount=Number(rows[0]?.pending_count??0);
 return {sha256,messageIds:rows.map(row=>row.id),count,omitted:count-messages.length,pendingCount,messages};
}
