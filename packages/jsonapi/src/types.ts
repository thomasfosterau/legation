/**
 * JSON:API Types
 *
 * Core type definitions following the JSON:API v1.1 specification
 * https://jsonapi.org/format/
 */

/**
 * JSON:API Resource Identifier
 */
export interface ResourceIdentifier {
  type: string;
  id: string;
  meta?: Record<string, unknown>;
}

/**
 * JSON:API Resource Object
 */
export interface ResourceObject extends ResourceIdentifier {
  attributes?: Record<string, unknown>;
  relationships?: Record<string, Relationship>;
  links?: Links;
}

/**
 * JSON:API Relationship
 */
export interface Relationship {
  data?: ResourceIdentifier | ResourceIdentifier[] | null;
  links?: Links;
  meta?: Record<string, unknown>;
}

/**
 * JSON:API Links
 */
export interface Links {
  self?: string | LinkObject;
  related?: string | LinkObject;
  [key: string]: string | LinkObject | undefined;
}

/**
 * JSON:API Link Object
 */
export interface LinkObject {
  href: string;
  meta?: Record<string, unknown>;
}

/**
 * JSON:API Error Object
 */
export interface JsonApiError {
  id?: string;
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
  source?: {
    pointer?: string;
    parameter?: string;
    header?: string;
  };
  meta?: Record<string, unknown>;
}

/**
 * JSON:API Document Structure
 */
export interface JsonApiDocument {
  data?: ResourceObject | ResourceObject[] | ResourceIdentifier | ResourceIdentifier[] | null;
  errors?: JsonApiError[];
  meta?: Record<string, unknown>;
  included?: ResourceObject[];
  links?: Links;
  jsonapi?: {
    version?: string;
    meta?: Record<string, unknown>;
  };
}

/**
 * JSON:API Request Options
 */
export interface JsonApiRequestOptions {
  include?: string[];
  fields?: Record<string, string[]>;
  sort?: string[];
  filter?: Record<string, string>;
  page?: {
    number?: number;
    size?: number;
    offset?: number;
    limit?: number;
    [key: string]: number | undefined;
  };
}
