import { z } from 'zod';
import { PolicyCategory, policyCategories, policyDefinitions, policySchemas, validatePolicy } from './policyContracts';

export function configurationReadiness(configurations: Partial<Record<PolicyCategory, unknown>>) {
  return policyCategories.map(category => {
    const config = configurations[category] || policyDefinitions[category].defaults;
    const validation = validatePolicy(category, config);
    const fields = Object.entries(policySchemas[category].shape).map(([name, schema]) => {
      let type: z.ZodTypeAny = schema;
      while (type instanceof z.ZodNullable || type instanceof z.ZodOptional) type = type.unwrap();
      return { name, type: type._def.typeName.replace('Zod', '').toLowerCase(), mandatorySafeguard: type instanceof z.ZodLiteral, acceptedValues: type instanceof z.ZodEnum ? type.options as string[] : type instanceof z.ZodLiteral ? [type.value] : undefined, missing: validation.missing.includes(name), rules: type instanceof z.ZodNumber ? type._def.checks : [], workflows: policyDefinitions[category].workflows };
    });
    return { category, name: policyDefinitions[category].name, state: !configurations[category] ? 'POLICY_NOT_CONFIGURED' : !validation.valid ? 'INVALID' : validation.missing.length ? 'INCOMPLETE' : 'CONFIGURED', validation, fields, workflows: policyDefinitions[category].workflows, agents: policyDefinitions[category].agents };
  });
}
