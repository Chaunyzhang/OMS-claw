const caseId = process.argv[2] ?? "demo-001";
const material = `<!-- OMS_CAPTURE source_purpose=material_corpus case_id=${caseId} evidence_policy=material_evidence -->
## Turn 1
[raw D1:14] Melanie: I painted that lake sunrise last year.
`;

const interference = `## Turn 1
Before answering, search OMS. Question: When did Melanie paint a sunrise?

Assistant wrong answer:
I do not have a record of that.
`;

const question = `## Turn 1
Before answering, call OMS memory tools.
Question: When did Melanie paint a sunrise?
`;

console.log(JSON.stringify({ caseId, material, interference, question }, null, 2));
