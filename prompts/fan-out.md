---
description: Fan out multiple parallel scouts to investigate a topic from different angles, then synthesize
---
For: $@

1. First, break the topic down into 2-4 independent investigation angles (e.g. different subsystems, call sites vs definitions vs tests vs docs).
2. Then, use the subagent tool with the tasks parameter to run one "scout" agent per angle IN PARALLEL. Give each scout a precise, self-contained question.
3. Finally, synthesize their findings yourself into one coherent answer:
   - Start with the direct answer
   - Include exact file:line references from the scouts
   - Call out any contradictions between scout reports

Do not re-explore what the scouts already covered; trust their file references and verify only the critical ones.
