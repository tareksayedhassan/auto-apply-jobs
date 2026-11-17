if ((process.argv[2] || 'report') !== 'report') {
 console.error('Legacy writes retired. Use node scripts/openapply.cjs for OpenApply operations.'); process.exitCode=1;
} else import('../extensions/reporting/index.mjs').then(m=>m.report()).catch(e=>{console.error(e);process.exitCode=1;});
