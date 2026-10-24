/** Explicit disposable database only; never derive permission from ambient DATABASE_URL. */
export function resourcePostgresUrl(value){
  if(!value)throw Error('RESOURCE_TEST_DATABASE_URL is required');
  const url=new URL(value);
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)
    ||!url.username||!url.password||!/^\d+$/.test(url.port)||Number(url.port)<1||Number(url.port)>65535
    ||!/^\/weiwu_resource_test_[a-zA-Z0-9_]+$/.test(url.pathname)||url.search||url.hash)throw Error('An explicit disposable loopback weiwu_resource_test_ database is required');
  return url;
}
export function resourcePostgresEnvironment(){
  const base=resourcePostgresUrl(process.env.RESOURCE_TEST_DATABASE_URL),schema=process.env.RESOURCE_TEST_SCHEMA;
  if(process.env.SIMULATED_INTEGRATION!=='resource-postgres'||!/^resource_[a-f0-9]{32}$/.test(schema??''))throw Error('Use scripts/test-resource-postgres.mjs');
  base.searchParams.set('options','-c search_path='+schema);
  if(process.env.DATABASE_URL!==base.href)throw Error('Unexpected resource test database/schema');
  return base.href;
}
