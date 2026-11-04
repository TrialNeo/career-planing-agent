// Language guardrails enforce the content-review boundary; they do not establish
// execution evidence. This application has no trusted execution verifier.
const success =
  /(?:运行|执行|测试|构建|编译)(?:均|全部|都|已|已经|实际|顺利|成功|完成|了|结果|并|且|[\s])*?(?:通过|成功|无(?:报)?错|正确)|(?:成功|顺利)(?:地)?(?:运行|执行|构建|编译)|(?:通过|完成)(?:了)?(?:所有|全部)?(?:单元|集成|自动化)?测试|\b(?:tests?|build|compilation)\s+(?:(?:have|has|all|already)\s+)*(?:passed|succeeded|successful)|\b(?:code|program|application)\s+(?:has\s+|have\s+|already\s+)?(?:ran|run|runs|executed)\s+successfully|\b(?:execute|run)\b[^.!?;\n]{0,60}\bsuccessfully\b/gi;

export function claimsExecutionSuccess(text: string, allowInstructions = false): boolean {
  const clauses = text.split(/[，,。；;！!？?\n]|\bbut\b|但是|然而|不过/iu);
  return clauses.some((clause) => {
    for (const match of clause.matchAll(success)) {
      const prefix = clause.slice(0, match.index).trim();
      // Negation must directly qualify this claim, rather than merely occurring
      // elsewhere in the paragraph ("未执行代码，但测试通过" is still rejected).
      if (
        /(?:不能|无法|尚不能|未能|不应|不可|没有|未|尚未|并未)(?:确认|证明|验证|认定|断言|保证|记录|说明)?\s*$|\b(?:cannot|can't|not|never|unable to)\s+(?:(?:confirm|verify|claim|prove)(?:\s+that)?)?\s*$/iu.test(
          prefix,
        )
      )
        continue;
      if (
        allowInstructions &&
        /^(?:请|需(?:要)?|建议|下一步|待|应当|应该)|\b(?:please|must|should|need to)\b/iu.test(
          prefix,
        ) &&
        /(?:后|再|确认|验证|检查|提供|补充)|\b(?:verify|confirm|then|after)\b/iu.test(clause)
      )
        continue;
      return true;
    }
    return false;
  });
}

export function requiresExecution(description: string): boolean {
  return /运行|执行|测试(?:通过|成功|结果)|(?:通过|完成|全(?:部)?|所有|单元|集成|自动化)测试|无报错|\b(?:run|running|runtime|execute|execution|tests?\s+(?:pass|success)|pass\s+(?:all\s+)?tests?)\b/iu.test(
    description,
  );
}
