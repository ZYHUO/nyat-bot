import "dotenv/config";
console.log("SMART_GROUP_ENABLED from process.env:", process.env.SMART_GROUP_ENABLED);
console.log("All SMART_GROUP vars:");
Object.entries(process.env).filter(([k]) => k.startsWith("SMART_GROUP")).forEach(([k, v]) => {
  console.log(`  ${k}=${v}`);
});
