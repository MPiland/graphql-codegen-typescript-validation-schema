import type {
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
  GraphQLSchema,
  InputObjectTypeDefinitionNode,
  InputValueDefinitionNode,
  InterfaceTypeDefinitionNode,
  NameNode,
  ObjectTypeDefinitionNode,
  TypeNode,
  UnionTypeDefinitionNode,
} from 'graphql';

import type { ValidationSchemaPluginConfig } from '../config.js';
import type { Visitor } from '../visitor.js';
import { resolveExternalModuleAndFn } from '@graphql-codegen/plugin-helpers';
import { convertNameParts, DeclarationBlock, indent } from '@graphql-codegen/visitor-plugin-common';
import {
  Kind,
} from 'graphql';
import { buildApi, formatDirectiveConfig } from '../directive.js';
import {
  escapeGraphQLCharacters,
  InterfaceTypeDefinitionBuilder,
  isInput,
  isListType,
  isNamedType,
  isNonNullType,
  ObjectTypeDefinitionBuilder,
} from '../graphql.js';
import { BaseSchemaVisitor } from '../schema_visitor.js';
import { findCircularTypes } from 'src/utils.js';

const anySchema = `definedNonNullAnySchema`;

export class MyZodSchemaVisitor extends BaseSchemaVisitor {
  private circularTypes: Set<string>
  constructor(schema: GraphQLSchema, config: ValidationSchemaPluginConfig) {
    super(schema, config);
    this.circularTypes = findCircularTypes(schema)
    this.config.lazyStrategy ??= 'all'
  }

  importValidationSchema(): string {
    return `import * as myzod from 'myzod'`;
  }

  initialEmit(): string {
    return (
      `\n${[
        new DeclarationBlock({}).export().asKind('const').withName(`${anySchema}`).withContent(`myzod.object({})`).string,
        ...this.enumDeclarations,
      ].join('\n')}`
    );
  }

  get InputObjectTypeDefinition() {
    return {
      leave: (node: InputObjectTypeDefinitionNode) => {
        const visitor = this.createVisitor('input');
        const name = visitor.convertName(node.name.value);
        this.importTypes.push(name);
        return this.buildInputFields(node.fields ?? [], visitor, name);
      },
    };
  }

  get InterfaceTypeDefinition() {
    return {
      leave: InterfaceTypeDefinitionBuilder(this.config.withObjectType, (node: InterfaceTypeDefinitionNode) => {
        const visitor = this.createVisitor('output');
        const name = visitor.convertName(node.name.value);
        const typeName = visitor.prefixTypeNamespace(name);
        this.importTypes.push(name);

        // Building schema for field arguments.
        const argumentBlocks = this.buildTypeDefinitionArguments(node, visitor);
        const appendArguments = argumentBlocks ? `\n${argumentBlocks}` : '';

        // Building schema for fields.
        const shape = node.fields?.map(field => generateFieldMyZodSchema(this.config, visitor, field, 2, this.circularTypes)).join(',\n');

        // Building schema object for separateSchemaObject config option
        const schemaObject = buildSchemaObject(name, '', typeName, shape)
        switch (this.config.validationSchemaExportType) {
          case 'const':
            switch (this.config.separateSchemaObject) {
              case true:
                return (
                  schemaObject.string +
                  new DeclarationBlock({})
                    .export()
                    .asKind('const')
                    .withName(`${name}Schema`)
                    .withContent(['myzod.object(', indent(schemaObject.name, 1), ')'].join('\n'))
                    .string + appendArguments
                )
              case false:
              default:
                return (
                  new DeclarationBlock({})
                    .export()
                    .asKind('const')
                    .withName(`${name}Schema: myzod.Type<${typeName}>`)
                    .withContent([`myzod.object({`, shape, '})'].join('\n'))
                    .string + appendArguments
                );
            }

          case 'function':
          default:
            switch (this.config.separateSchemaObject) {
              case true:
                return (
                  schemaObject.string +
                  new DeclarationBlock({})
                    .export()
                    .asKind('function')
                    .withName(`${name}Schema()`)
                    .withBlock([indent('return myzod.object('), indent(schemaObject.name, 1), indent(')')].join('\n'))
                    .string + appendArguments
                )
              case false:
              default:
                return (
                  new DeclarationBlock({})
                    .export()
                    .asKind('function')
                    .withName(`${name}Schema(): myzod.Type<${typeName}>`)
                    .withBlock([indent('return myzod.object({'), shape, indent('})')].join('\n'))
                    .string + appendArguments
                );
            }
        }
      }),
    };
  }

  get ObjectTypeDefinition() {
    return {
      leave: ObjectTypeDefinitionBuilder(this.config.withObjectType, (node: ObjectTypeDefinitionNode) => {
        const visitor = this.createVisitor('output');
        const name = visitor.convertName(node.name.value);
        const typeName = visitor.prefixTypeNamespace(name);
        this.importTypes.push(name);

        // Building schema for field arguments.
        const argumentBlocks = this.buildTypeDefinitionArguments(node, visitor);
        const appendArguments = argumentBlocks ? `\n${argumentBlocks}` : '';

        // Building schema for fields.
        const shape = node.fields?.map(field => generateFieldMyZodSchema(this.config, visitor, field, 2, this.circularTypes)).join(',\n');

        // Building schema object for separateSchemaObject config option
        const schemaObject = buildSchemaObject(name, `__typename: myzod.literal('${node.name.value}').optional(),`, typeName, shape)
        switch (this.config.validationSchemaExportType) {
          case 'const':
            switch (this.config.separateSchemaObject) {
              case true:
                return (
                  schemaObject.string +
                  new DeclarationBlock({})
                    .export()
                    .asKind('const')
                    .withName(`${name}Schema`)
                    .withContent(
                      [
                        'myzod.object(',
                        indent(schemaObject.name, 1),
                        ')',
                      ].join('\n'),
                    )
                    .string + appendArguments
                )
              case false:
              default:
                return (
                  new DeclarationBlock({})
                    .export()
                    .asKind('const')
                    .withName(`${name}Schema: myzod.Type<${typeName}>`)
                    .withContent(
                      [
                        'myzod.object({',
                        indent(`__typename: myzod.literal('${node.name.value}').optional(),`, 2),
                        shape,
                        '})',
                      ].join('\n'),
                    )
                    .string + appendArguments
                );
            }
          case 'function':
          default:
            switch (this.config.separateSchemaObject) {
              case true:
                return (
                  schemaObject.string +
                  new DeclarationBlock({})
                    .export()
                    .asKind('function')
                    .withName(`${name}Schema()`)
                    .withBlock(
                      [
                        indent('return myzod.object('),
                        indent(schemaObject.name, 1),
                        indent(')'),
                      ].join('\n'),
                    )
                    .string + appendArguments
                )
              case false:
              default:
                return (
                  new DeclarationBlock({})
                    .export()
                    .asKind('function')
                    .withName(`${name}Schema(): myzod.Type<${typeName}>`)
                    .withBlock(
                      [
                        indent('return myzod.object({'),
                        indent(`__typename: myzod.literal('${node.name.value}').optional(),`, 2),
                        shape,
                        indent('})'),
                      ].join('\n'),
                    )
                    .string + appendArguments
                );
            }
        }
      }),
    };
  }

  get EnumTypeDefinition() {
    return {
      leave: (node: EnumTypeDefinitionNode) => {
        const visitor = this.createVisitor('both');
        const enumname = visitor.convertName(node.name.value);
        const enumTypeName = visitor.prefixTypeNamespace(enumname);
        this.importTypes.push(enumname);
        // z.enum are basically myzod.literals
        // hoist enum declarations
        this.enumDeclarations.push(
          this.config.enumsAsTypes
            ? new DeclarationBlock({})
              .export()
              .asKind('type')
              .withName(`${enumname}Schema`)
              .withContent(
                `myzod.literals(${node.values?.map(enumOption => `'${enumOption.name.value}'`).join(', ')})`,
              )
              .string
            : new DeclarationBlock({})
              .export()
              .asKind('const')
              .withName(`${enumname}Schema`)
              .withContent(`myzod.enum(${enumTypeName})`)
              .string,
        );
      },
    };
  }

  get UnionTypeDefinition() {
    return {
      leave: (node: UnionTypeDefinitionNode) => {
        if (!node.types || !this.config.withObjectType)
          return;

        const visitor = this.createVisitor('output');

        const unionName = visitor.convertName(node.name.value);
        const unionElements = node.types?.map((t) => {
          const element = visitor.convertName(t.name.value);
          const typ = visitor.getType(t.name.value);
          if (typ?.astNode?.kind === 'EnumTypeDefinition')
            return `${element}Schema`;

          switch (this.config.validationSchemaExportType) {
            case 'const':
              return `${element}Schema`;
            case 'function':
            default:
              return `${element}Schema()`;
          }
        }).join(', ');
        const unionElementsCount = node.types?.length ?? 0;

        const union = unionElementsCount > 1 ? `myzod.union([${unionElements}])` : unionElements;

        switch (this.config.validationSchemaExportType) {
          case 'const':
            return new DeclarationBlock({}).export().asKind('const').withName(`${unionName}Schema`).withContent(union).string;
          case 'function':
          default:
            return new DeclarationBlock({})
              .export()
              .asKind('function')
              .withName(`${unionName}Schema()`)
              .withBlock(indent(`return ${union}`))
              .string;
        }
      },
    };
  }

  protected buildInputFields(
    fields: readonly (FieldDefinitionNode | InputValueDefinitionNode)[],
    visitor: Visitor,
    name: string,
  ) {
    const typeName = visitor.prefixTypeNamespace(name);
    const shape = fields.map(field => generateFieldMyZodSchema(this.config, visitor, field, 2, this.circularTypes)).join(',\n');
    const discriminatorField =
      this.config.inputDiscriminator ?
        `${indent(this.config.inputDiscriminator, this.config.validationSchemaExportType === 'const' ? 1 : 2)}: myzod.literal('${name}'),'),`
        : ''
    const schemaObject = buildSchemaObject(name, discriminatorField, typeName, shape)
    switch (this.config.validationSchemaExportType) {
      case 'const':
        switch (this.config.separateSchemaObject) {
          case true:
            return schemaObject.string + new DeclarationBlock({})
              .export()
              .asKind('const')
              .withName(`${name}Schema`)
              .withContent(['myzod.object(', indent(schemaObject.name, 1), ')'].join('\n'))
              .string;
          case false:
          default:
            return new DeclarationBlock({})
              .export()
              .asKind('const')
              .withName(`${name}Schema: myzod.Type<${typeName}>`)
              .withContent(['myzod.object({', shape, '})'].join('\n'))
              .string;
        }
      case 'function':
      default:
        switch (this.config.separateSchemaObject) {
          case true:
            return schemaObject.string + new DeclarationBlock({})
              .export()
              .asKind('function')
              .withName(`${name}Schema()`)
              .withBlock([indent('return myzod.object('), indent(schemaObject.name, 1), indent(')')].join('\n'))
              .string;

          case false:
          default:
            return new DeclarationBlock({})
              .export()
              .asKind('function')
              .withName(`${name}Schema(): myzod.Type<${typeName}>`)
              .withBlock([indent(`return myzod.object({`), shape, indent('})')].join('\n'))
              .string;
        }
    }
  }
}

function generateFieldMyZodSchema(config: ValidationSchemaPluginConfig, visitor: Visitor, field: InputValueDefinitionNode | FieldDefinitionNode, indentCount: number, circularTypes: Set<string>): string {
  const gen = generateFieldTypeMyZodSchema(config, visitor, field, field.type, circularTypes);
  return indent(`${field.name.value}: ${maybeLazy(field.type, gen, config, circularTypes)}`, indentCount);
}

function generateFieldTypeMyZodSchema(config: ValidationSchemaPluginConfig, visitor: Visitor, field: InputValueDefinitionNode | FieldDefinitionNode, type: TypeNode, circularTypes: Set<string>, parentType?: TypeNode): string {
  if (isListType(type)) {
    const gen = generateFieldTypeMyZodSchema(config, visitor, field, type.type, circularTypes, type);
    if (!isNonNullType(parentType)) {
      const arrayGen = `myzod.array(${maybeLazy(type.type, gen, config, circularTypes)})`;
      const maybeLazyGen = applyDirectives(config, field, arrayGen);
      return `${maybeLazyGen}.optional().nullable()`;
    }
    return `myzod.array(${maybeLazy(type.type, gen, config, circularTypes)})`;
  }
  if (isNonNullType(type)) {
    const gen = generateFieldTypeMyZodSchema(config, visitor, field, type.type, circularTypes, type);
    return maybeLazy(type.type, gen, config, circularTypes);
  }
  if (isNamedType(type)) {
    const gen = generateNameNodeMyZodSchema(config, visitor, type.name);
    if (isListType(parentType))
      return `${gen}.nullable()`;

    let appliedDirectivesGen = applyDirectives(config, field, gen);

    if (field.kind === Kind.INPUT_VALUE_DEFINITION) {
      const { defaultValue } = field;

      if (defaultValue?.kind === Kind.INT || defaultValue?.kind === Kind.FLOAT || defaultValue?.kind === Kind.BOOLEAN)
        appliedDirectivesGen = `${appliedDirectivesGen}.default(${defaultValue.value})`;

      if (defaultValue?.kind === Kind.STRING || defaultValue?.kind === Kind.ENUM) {
        if (config.useEnumTypeAsDefaultValue && defaultValue?.kind !== Kind.STRING) {
          let value = convertNameParts(defaultValue.value, resolveExternalModuleAndFn('change-case-all#pascalCase'), config?.namingConvention?.transformUnderscore);

          if (config.namingConvention?.enumValues)
            value = convertNameParts(defaultValue.value, resolveExternalModuleAndFn(config.namingConvention?.enumValues), config?.namingConvention?.transformUnderscore);

          appliedDirectivesGen = `${appliedDirectivesGen}.default(${visitor.convertName(type.name.value)}.${value})`;
        }
        else {
          appliedDirectivesGen = `${appliedDirectivesGen}.default("${escapeGraphQLCharacters(defaultValue.value)}")`;
        }
      }
    }

    if (isNonNullType(parentType)) {
      if (visitor.shouldEmitAsNotAllowEmptyString(type.name.value))
        return `${gen}.min(1)`;

      return appliedDirectivesGen;
    }
    if (isListType(parentType))
      return `${appliedDirectivesGen}.nullable()`;

    return `${appliedDirectivesGen}.optional().nullable()`;
  }
  console.warn('unhandled type:', type);
  return '';
}

function applyDirectives(config: ValidationSchemaPluginConfig, field: InputValueDefinitionNode | FieldDefinitionNode, gen: string): string {
  if (config.directives && field.directives) {
    const formatted = formatDirectiveConfig(config.directives);
    return gen + buildApi(formatted, field.directives);
  }
  return gen;
}

function generateNameNodeMyZodSchema(config: ValidationSchemaPluginConfig, visitor: Visitor, node: NameNode): string {
  const converter = visitor.getNameNodeConverter(node);

  switch (converter?.targetKind) {
    case 'InterfaceTypeDefinition':
    case 'InputObjectTypeDefinition':
    case 'ObjectTypeDefinition':
    case 'UnionTypeDefinition':
      // using switch-case rather than if-else to allow for future expansion
      switch (config.validationSchemaExportType) {
        case 'const':
          return `${converter.convertName()}Schema`;
        case 'function':
        default:
          return `${converter.convertName()}Schema()`;
      }
    case 'EnumTypeDefinition':
      return `${converter.convertName()}Schema`;
    case 'ScalarTypeDefinition':
      return myzod4Scalar(config, visitor, node.value);
    default:
      if (converter?.targetKind)
        console.warn('Unknown target kind', converter.targetKind);

      return myzod4Scalar(config, visitor, node.value);
  }
}

function maybeLazy(type: TypeNode, schema: string, config: ValidationSchemaPluginConfig, circularTypes: Set<string>) {
  if (isNamedType(type)) {
    const typeName = type.name.value

    if (config.lazyStrategy === 'all' && isInput(typeName)) {
      return `myzod.lazy(() => ${schema})`
    }

    if (config.lazyStrategy === 'circular' && circularTypes.has(typeName)) {
      return `myzod.lazy(() => ${schema})`
    }
  }

  return schema
}

function myzod4Scalar(config: ValidationSchemaPluginConfig, visitor: Visitor, scalarName: string): string {
  if (config.scalarSchemas?.[scalarName])
    return config.scalarSchemas[scalarName];

  const tsType = visitor.getScalarType(scalarName);
  switch (tsType) {
    case 'string':
      return `myzod.string()`;
    case 'number':
      return `myzod.number()`;
    case 'boolean':
      return `myzod.boolean()`;
  }

  if (config.defaultScalarTypeSchema) {
    return config.defaultScalarTypeSchema;
  }

  console.warn('unhandled name:', scalarName);
  return anySchema;
}

function buildSchemaObject(name: string, discriminator: string, typeName: string, shape: string | undefined) {
  const objectName = name.charAt(0).toLowerCase() + name.slice(1) + 'SchemaObject'
  return {
    string: `export const ${objectName}: Properties<${typeName}> = {\n${discriminator}\n${shape}\n}\n\n`,
    name: objectName,
  }
}
