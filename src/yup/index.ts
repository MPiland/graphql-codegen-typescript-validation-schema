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

export class YupSchemaVisitor extends BaseSchemaVisitor {
  private circularTypes: Set<string>
  constructor(schema: GraphQLSchema, config: ValidationSchemaPluginConfig) {
    super(schema, config);
    this.circularTypes = findCircularTypes(schema)
    this.config.lazyStrategy ??= 'all'
  }

  importValidationSchema(): string {
    return `import * as yup from 'yup'`;
  }

  initialEmit(): string {
    if (!this.config.withObjectType)
      return `\n${this.enumDeclarations.join('\n')}`;
    return (
      `\n${this.enumDeclarations.join('\n')
      }\n${new DeclarationBlock({})
        .asKind('function')
        .withName('union<T extends {}>(...schemas: ReadonlyArray<yup.Schema<T>>): yup.MixedSchema<T>')
        .withBlock(
          [
            indent('return yup.mixed<T>().test({'),
            indent('test: (value) => schemas.some((schema) => schema.isValidSync(value))', 2),
            indent('}).defined()'),
          ].join('\n'),
        )
        .string}`
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
        const shape = node.fields?.map((field) => {
          const fieldSchema = generateFieldYupSchema(this.config, visitor, field, 2, this.circularTypes);
          return isNonNullType(field.type) ? fieldSchema : `${fieldSchema}.optional()`;
        }).join(',\n');

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
                    .withContent(['yup.object(', indent(schemaObject.name, 1), ')'].join('\n'))
                    .string + appendArguments
                )
              case false:
              default:
                return (
                  new DeclarationBlock({})
                    .export()
                    .asKind('const')
                    .withName(`${name}Schema: yup.ObjectSchema<${typeName}>`)
                    .withContent([`yup.object({`, shape, '})'].join('\n'))
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
                    .withBlock([indent('return yup.object('), indent(schemaObject.name, 1), indent(')')].join('\n'))
                    .string + appendArguments
                )
              case false:
              default:
                return (
                  new DeclarationBlock({})
                    .export()
                    .asKind('function')
                    .withName(`${name}Schema(): yup.ObjectSchema<${typeName}>`)
                    .withBlock([indent('return yup.object({'), shape, indent('})')].join('\n'))
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
        const shape = shapeFields(node.fields, this.config, visitor);

        // Building schema object for separateSchemaObject config option
        const schemaObject = buildSchemaObject(name, `__typename: yup.string<'${node.name.value}'>().optional(),`, typeName, shape)
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
                        'z.object(',
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
                    .withName(`${name}Schema: yup.ObjectSchema<${typeName}>`)
                    .withContent(
                      [
                        'z.object({',
                        indent(`__typename: yup.string<'${node.name.value}'>().optional(),`, 2),
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
                        indent('return z.object('),
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
                    .withName(`${name}Schema(): yup.ObjectSchema<${typeName}>`)
                    .withBlock(
                      [
                        indent('return z.object({'),
                        indent(`__typename: yup.string<'${node.name.value}'>().optional(),`, 2),
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

        // hoise enum declarations
        if (this.config.enumsAsTypes) {
          const enums = node.values?.map(enumOption => `'${enumOption.name.value}'`);

          this.enumDeclarations.push(
            new DeclarationBlock({})
              .export()
              .asKind('const')
              .withName(`${enumname}Schema`)
              .withContent(`yup.string().oneOf([${enums?.join(', ')}]).defined()`).string,
          );
        }
        else {
          this.enumDeclarations.push(
            new DeclarationBlock({})
              .export()
              .asKind('const')
              .withName(`${enumname}Schema`)
              .withContent(`yup.string<${enumTypeName}>().oneOf(Object.values(${enumTypeName})).defined()`).string,
          );
        }
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
        const unionTypeName = visitor.prefixTypeNamespace(unionName);
        this.importTypes.push(unionName);

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

        switch (this.config.validationSchemaExportType) {
          case 'const':
            return new DeclarationBlock({})
              .export()
              .asKind('const')
              .withName(`${unionName}Schema: yup.MixedSchema<${unionTypeName}>`)
              .withContent(`union<${unionTypeName}>(${unionElements})`)
              .string;
          case 'function':
          default:
            return new DeclarationBlock({})
              .export()
              .asKind('function')
              .withName(`${unionName}Schema(): yup.MixedSchema<${unionTypeName}>`)
              .withBlock(indent(`return union<${unionTypeName}>(${unionElements})`))
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
    const shape = shapeFields(fields, this.config, visitor);
    const discriminatorField =
      this.config.inputDiscriminator ?
        `${indent(this.config.inputDiscriminator, this.config.validationSchemaExportType === 'const' ? 1 : 2)}: yup.string<'${name}'>(),'),`
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
              .withContent(['yup.object(', indent(schemaObject.name, 1), ')'].join('\n'))
              .string;
          case false:
          default:
            return new DeclarationBlock({})
              .export()
              .asKind('const')
              .withName(`${name}Schema: yup.ObjectSchema<${typeName}>`)
              .withContent(['yup.object({', shape, '})'].join('\n'))
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
              .withBlock([indent('return yup.object('), indent(schemaObject.name, 1), indent(')')].join('\n'))
              .string;

          case false:
          default:
            return new DeclarationBlock({})
              .export()
              .asKind('function')
              .withName(`${name}Schema(): yup.ObjectSchema<${typeName}>`)
              .withBlock([indent(`return yup.object({`), shape, indent('})')].join('\n'))
              .string;
        }
    }
  }
}

function shapeFields(fields: readonly (FieldDefinitionNode | InputValueDefinitionNode)[] | undefined, config: ValidationSchemaPluginConfig, visitor: Visitor) {
  return fields
    ?.map((field) => {
      let fieldSchema = generateFieldYupSchema(config, visitor, field, 2, this.circularTypes);

      if (field.kind === Kind.INPUT_VALUE_DEFINITION) {
        const { defaultValue } = field;

        if (
          defaultValue?.kind === Kind.INT
          || defaultValue?.kind === Kind.FLOAT
          || defaultValue?.kind === Kind.BOOLEAN
        ) {
          fieldSchema = `${fieldSchema}.default(${defaultValue.value})`;
        }

        if (defaultValue?.kind === Kind.STRING || defaultValue?.kind === Kind.ENUM) {
          if (config.useEnumTypeAsDefaultValue && defaultValue?.kind !== Kind.STRING) {
            let value = convertNameParts(defaultValue.value, resolveExternalModuleAndFn('change-case-all#pascalCase'), config?.namingConvention?.transformUnderscore);

            if (config.namingConvention?.enumValues)
              value = convertNameParts(defaultValue.value, resolveExternalModuleAndFn(config.namingConvention?.enumValues), config?.namingConvention?.transformUnderscore);

            fieldSchema = `${fieldSchema}.default(${visitor.convertName(field.name.value)}.${value})`;
          }
          else {
            fieldSchema = `${fieldSchema}.default("${escapeGraphQLCharacters(defaultValue.value)}")`;
          }
        }
      }

      if (isNonNullType(field.type))
        return fieldSchema;

      return `${fieldSchema}.optional()`;
    })
    .join(',\n');
}

function generateFieldYupSchema(config: ValidationSchemaPluginConfig, visitor: Visitor, field: InputValueDefinitionNode | FieldDefinitionNode, indentCount: number, circularTypes: Set<string>): string {
  let gen = generateFieldTypeYupSchema(config, visitor, field.type, circularTypes);
  if (config.directives && field.directives) {
    const formatted = formatDirectiveConfig(config.directives);
    gen += buildApi(formatted, field.directives);
  }
  return indent(`${field.name.value}: ${maybeLazy(field.type, gen, config, circularTypes)}`, indentCount);
}

function generateFieldTypeYupSchema(config: ValidationSchemaPluginConfig, visitor: Visitor, type: TypeNode, circularTypes: Set<string>, parentType?: TypeNode): string {
  if (isListType(type)) {
    const gen = generateFieldTypeYupSchema(config, visitor, type.type, circularTypes, type);
    if (!isNonNullType(parentType))
      return `yup.array(${maybeLazy(type.type, gen, config, circularTypes)}).defined().nullable()`;

    return `yup.array(${maybeLazy(type.type, gen, config, circularTypes)}).defined()`;
  }
  if (isNonNullType(type)) {
    const gen = generateFieldTypeYupSchema(config, visitor, type.type, circularTypes, type);
    return maybeLazy(type.type, gen, config, circularTypes);
  }
  if (isNamedType(type)) {
    const gen = generateNameNodeYupSchema(config, visitor, type.name);
    if (isNonNullType(parentType)) {
      if (visitor.shouldEmitAsNotAllowEmptyString(type.name.value))
        return `${gen}.required()`;

      return `${gen}.nonNullable()`;
    }
    const typ = visitor.getType(type.name.value);
    if (typ?.astNode?.kind === 'InputObjectTypeDefinition')
      return `${gen}`;

    return `${gen}.nullable()`;
  }
  console.warn('unhandled type:', type);
  return '';
}

function generateNameNodeYupSchema(config: ValidationSchemaPluginConfig, visitor: Visitor, node: NameNode): string {
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
    default:
      return yup4Scalar(config, visitor, node.value);
  }
}

function maybeLazy(type: TypeNode, schema: string, config: ValidationSchemaPluginConfig, circularTypes: Set<string>) {
  if (isNamedType(type)) {
    const typeName = type.name.value

    if (config.lazyStrategy === 'all' && isInput(typeName)) {
      return `yup.lazy(() => ${schema})`
    }

    if (config.lazyStrategy === 'circular' && circularTypes.has(typeName)) {
      return `yup.lazy(() => ${schema})`
    }
  }

  return schema
}

function yup4Scalar(config: ValidationSchemaPluginConfig, visitor: Visitor, scalarName: string): string {
  if (config.scalarSchemas?.[scalarName])
    return `${config.scalarSchemas[scalarName]}.defined()`;

  const tsType = visitor.getScalarType(scalarName);
  switch (tsType) {
    case 'string':
      return `yup.string().defined()`;
    case 'number':
      return `yup.number().defined()`;
    case 'boolean':
      return `yup.boolean().defined()`;
  }

  if (config.defaultScalarTypeSchema) {
    return config.defaultScalarTypeSchema
  }

  console.warn('unhandled name:', scalarName);
  return `yup.mixed()`;
}


function buildSchemaObject(name: string, discriminator: string, typeName: string, shape: string | undefined) {
  const objectName = name.charAt(0).toLowerCase() + name.slice(1) + 'SchemaObject'
  return {
    string: `export const ${objectName}: ${typeName} = {\n${discriminator}\n${shape}\n}\n\n`,
    name: objectName,
  }
}
