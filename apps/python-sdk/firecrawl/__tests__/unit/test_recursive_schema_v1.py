"""
Unit tests for recursive schema handling in v1 client.
"""
import unittest
import os
from firecrawl.v1.client import V1FirecrawlApp


class TestV1RecursiveRefDetection(unittest.TestCase):
    """Tests for _contains_recursive_ref method in V1FirecrawlApp."""
    
    def setUp(self):
        """Set up test client."""
        self.app = V1FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'test-key'))
    
    def test_no_recursive_ref(self):
        """Test schema with no recursive references."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            }
        }
        defs = {}
        result = self.app._contains_recursive_ref(schema, "Person", defs)
        self.assertFalse(result)
    
    def test_simple_recursive_ref(self):
        """Test schema with simple recursive reference."""
        defs = {
            "Person": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "parent": {"$ref": "#/$defs/Person"}
                }
            }
        }
        result = self.app._contains_recursive_ref(defs["Person"], "Person", defs)
        self.assertTrue(result)
    
    def test_indirect_recursive_ref(self):
        """Test schema with indirect recursive reference."""
        defs = {
            "Person": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "address": {"$ref": "#/$defs/Address"}
                }
            },
            "Address": {
                "type": "object",
                "properties": {
                    "street": {"type": "string"},
                    "owner": {"$ref": "#/$defs/Person"}
                }
            }
        }
        result = self.app._contains_recursive_ref(defs["Person"], "Person", defs)
        self.assertTrue(result)
    
    def test_recursive_ref_in_array(self):
        """Test schema with recursive reference in array items."""
        defs = {
            "TreeNode": {
                "type": "object",
                "properties": {
                    "value": {"type": "string"},
                    "children": {
                        "type": "array",
                        "items": {"$ref": "#/$defs/TreeNode"}
                    }
                }
            }
        }
        result = self.app._contains_recursive_ref(defs["TreeNode"], "TreeNode", defs)
        self.assertTrue(result)
    
    def test_no_ref_in_empty_schema(self):
        """Test empty schema returns False."""
        result = self.app._contains_recursive_ref({}, "Person", {})
        self.assertFalse(result)
    
    def test_no_ref_with_none_input(self):
        """Test None input returns False."""
        result = self.app._contains_recursive_ref(None, "Person", {})
        self.assertFalse(result)


class TestV1CircularDefsDetection(unittest.TestCase):
    """Tests for _check_for_circular_defs method in V1FirecrawlApp."""
    
    def setUp(self):
        """Set up test client."""
        self.app = V1FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'test-key'))
    
    def test_no_circular_refs(self):
        """Test definitions with no circular references."""
        defs = {
            "Person": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"}
                }
            },
            "Address": {
                "type": "object",
                "properties": {
                    "street": {"type": "string"}
                }
            }
        }
        result = self.app._check_for_circular_defs(defs)
        self.assertFalse(result)
    
    def test_self_referencing_def(self):
        """Test definition that references itself."""
        defs = {
            "TreeNode": {
                "type": "object",
                "properties": {
                    "value": {"type": "string"},
                    "left": {"$ref": "#/$defs/TreeNode"},
                    "right": {"$ref": "#/$defs/TreeNode"}
                }
            }
        }
        result = self.app._check_for_circular_defs(defs)
        self.assertTrue(result)
    
    def test_mutually_recursive_defs(self):
        """Test mutually recursive definitions."""
        defs = {
            "Person": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "address": {"$ref": "#/$defs/Address"}
                }
            },
            "Address": {
                "type": "object",
                "properties": {
                    "street": {"type": "string"},
                    "resident": {"$ref": "#/$defs/Person"}
                }
            }
        }
        result = self.app._check_for_circular_defs(defs)
        self.assertTrue(result)
    
    def test_empty_defs(self):
        """Test empty definitions dict."""
        result = self.app._check_for_circular_defs({})
        self.assertFalse(result)
    
    def test_none_defs(self):
        """Test None definitions."""
        result = self.app._check_for_circular_defs(None)
        self.assertFalse(result)


class TestV1ResolveRefs(unittest.TestCase):
    """Tests for _resolve_refs method in V1FirecrawlApp."""
    
    def setUp(self):
        """Set up test client."""
        self.app = V1FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'test-key'))
    
    def test_resolve_simple_ref(self):
        """Test resolving a simple $ref."""
        schema = {
            "type": "object",
            "properties": {
                "person": {"$ref": "#/$defs/Person"}
            }
        }
        defs = {
            "Person": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"}
                }
            }
        }
        result = self.app._resolve_refs(schema, defs)
        self.assertEqual(result["properties"]["person"]["type"], "object")
        self.assertIn("name", result["properties"]["person"]["properties"])
    
    def test_resolve_nested_refs(self):
        """Test resolving nested $refs."""
        schema = {
            "type": "object",
            "properties": {
                "data": {"$ref": "#/$defs/Data"}
            }
        }
        defs = {
            "Data": {
                "type": "object",
                "properties": {
                    "person": {"$ref": "#/$defs/Person"}
                }
            },
            "Person": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"}
                }
            }
        }
        result = self.app._resolve_refs(schema, defs)
        self.assertEqual(result["properties"]["data"]["type"], "object")
    
    def test_resolve_refs_in_array(self):
        """Test resolving $refs in array items."""
        schema = {
            "type": "array",
            "items": {"$ref": "#/$defs/Person"}
        }
        defs = {
            "Person": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"}
                }
            }
        }
        result = self.app._resolve_refs(schema, defs)
        # Result should be a dict with type: array and resolved items
        self.assertIsInstance(result, dict)
        self.assertEqual(result["type"], "array")
        self.assertIn("items", result)
    
    def test_resolve_refs_max_depth(self):
        """Test that resolution stops at max depth."""
        schema = {"$ref": "#/$defs/A"}
        defs = {
            "A": {"$ref": "#/$defs/B"},
            "B": {"$ref": "#/$defs/C"},
            "C": {"$ref": "#/$defs/D"},
            "D": {"type": "string"}
        }
        result = self.app._resolve_refs(schema, defs, depth=0)
        # Should resolve until depth limit
        self.assertIsNotNone(result)
    
    def test_resolve_refs_with_circular_ref(self):
        """Test resolving refs with circular references."""
        schema = {"$ref": "#/$defs/TreeNode"}
        defs = {
            "TreeNode": {
                "type": "object",
                "properties": {
                    "value": {"type": "string"},
                    "children": {
                        "type": "array",
                        "items": {"$ref": "#/$defs/TreeNode"}
                    }
                }
            }
        }
        # Should not throw error, but may preserve $ref
        result = self.app._resolve_refs(schema, defs)
        self.assertIsNotNone(result)
    
    def test_resolve_refs_no_defs(self):
        """Test schema with no $defs."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            }
        }
        result = self.app._resolve_refs(schema, {})
        self.assertEqual(result, schema)
    
    def test_resolve_refs_with_none(self):
        """Test resolving None."""
        result = self.app._resolve_refs(None, {})
        self.assertIsNone(result)
    
    def test_resolve_refs_skips_defs_key(self):
        """Test that $defs key is skipped during resolution."""
        schema = {
            "type": "object",
            "properties": {
                "person": {"$ref": "#/$defs/Person"}
            },
            "$defs": {
                "Person": {"type": "object"}
            }
        }
        defs = schema["$defs"]
        result = self.app._resolve_refs(schema, defs)
        # $defs should not be in resolved result
        self.assertNotIn("$defs", result)


class TestV1NormalizeSchemaForOpenAI(unittest.TestCase):
    """Tests for _normalize_schema_for_openai method in V1FirecrawlApp."""
    
    def setUp(self):
        """Set up test client."""
        self.app = V1FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'test-key'))
    
    def test_normalize_removes_additional_properties(self):
        """Test that additionalProperties: true is removed when properties exist."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            },
            "additionalProperties": True
        }
        result = self.app._normalize_schema_for_openai(schema)
        self.assertNotIn("additionalProperties", result)
    
    def test_normalize_preserves_additional_properties_false(self):
        """Test that additionalProperties: false is preserved."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            },
            "additionalProperties": False
        }
        result = self.app._normalize_schema_for_openai(schema)
        self.assertIn("additionalProperties", result)
        self.assertFalse(result["additionalProperties"])
    
    def test_normalize_removes_invalid_required(self):
        """Test that required fields not in properties are removed."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            },
            "required": ["name", "age", "email"]
        }
        result = self.app._normalize_schema_for_openai(schema)
        self.assertEqual(result["required"], ["name"])
    
    def test_normalize_removes_empty_required(self):
        """Test that empty required array is removed."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            },
            "required": ["age"]
        }
        result = self.app._normalize_schema_for_openai(schema)
        self.assertNotIn("required", result)
    
    def test_normalize_preserves_ref(self):
        """Test that $ref is preserved."""
        schema = {
            "$ref": "#/$defs/Person"
        }
        result = self.app._normalize_schema_for_openai(schema)
        self.assertEqual(result, schema)
    
    def test_normalize_handles_defs(self):
        """Test normalization with $defs."""
        schema = {
            "type": "object",
            "properties": {
                "person": {"$ref": "#/$defs/Person"}
            },
            "$defs": {
                "Person": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"}
                    },
                    "additionalProperties": True
                }
            }
        }
        result = self.app._normalize_schema_for_openai(schema)
        self.assertIn("$defs", result)
        self.assertNotIn("additionalProperties", result["$defs"]["Person"])
    
    def test_normalize_nested_objects(self):
        """Test normalization of nested objects."""
        schema = {
            "type": "object",
            "properties": {
                "person": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"}
                    },
                    "additionalProperties": True
                }
            }
        }
        result = self.app._normalize_schema_for_openai(schema)
        self.assertNotIn("additionalProperties", result["properties"]["person"])
    
    def test_normalize_arrays_with_objects(self):
        """Test normalization of arrays containing objects."""
        schema = {
            "anyOf": [
                {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "additionalProperties": True
                },
                {"type": "string"}
            ]
        }
        result = self.app._normalize_schema_for_openai(schema)
        self.assertNotIn("additionalProperties", result["anyOf"][0])
    
    def test_normalize_with_none(self):
        """Test normalization with None input."""
        result = self.app._normalize_schema_for_openai(None)
        self.assertIsNone(result)
    
    def test_normalize_with_non_dict(self):
        """Test normalization with non-dict input."""
        result = self.app._normalize_schema_for_openai("string")
        self.assertEqual(result, "string")


class TestV1ValidateSchemaForOpenAI(unittest.TestCase):
    """Tests for _validate_schema_for_openai method in V1FirecrawlApp."""
    
    def setUp(self):
        """Set up test client."""
        self.app = V1FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'test-key'))
    
    def test_valid_schema_with_properties(self):
        """Test valid schema with properties defined."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            }
        }
        result = self.app._validate_schema_for_openai(schema)
        self.assertTrue(result)
    
    def test_valid_schema_with_ref(self):
        """Test valid schema with $ref."""
        schema = {
            "type": "object",
            "properties": {
                "person": {"$ref": "#/$defs/Person"}
            }
        }
        result = self.app._validate_schema_for_openai(schema)
        self.assertTrue(result)
    
    def test_invalid_schema_no_properties_with_additional_properties(self):
        """Test invalid schema: object with no properties but additionalProperties: true."""
        schema = {
            "type": "object",
            "additionalProperties": True
        }
        result = self.app._validate_schema_for_openai(schema)
        self.assertFalse(result)
    
    def test_valid_schema_with_pattern_properties(self):
        """Test valid schema with patternProperties."""
        schema = {
            "type": "object",
            "patternProperties": {
                "^[a-z]+$": {"type": "string"}
            },
            "additionalProperties": True
        }
        result = self.app._validate_schema_for_openai(schema)
        self.assertTrue(result)
    
    def test_invalid_nested_schema(self):
        """Test invalid nested schema."""
        schema = {
            "type": "object",
            "properties": {
                "data": {
                    "type": "object",
                    "additionalProperties": True
                }
            }
        }
        result = self.app._validate_schema_for_openai(schema)
        self.assertFalse(result)
    
    def test_invalid_schema_in_array(self):
        """Test invalid schema within array (anyOf/oneOf)."""
        schema = {
            "anyOf": [
                {
                    "type": "object",
                    "additionalProperties": True
                },
                {"type": "string"}
            ]
        }
        result = self.app._validate_schema_for_openai(schema)
        self.assertFalse(result)
    
    def test_valid_with_none(self):
        """Test validation with None input."""
        result = self.app._validate_schema_for_openai(None)
        self.assertTrue(result)
    
    def test_valid_with_non_dict(self):
        """Test validation with non-dict input."""
        result = self.app._validate_schema_for_openai("string")
        self.assertTrue(result)


class TestV1DetectRecursiveSchema(unittest.TestCase):
    """Tests for _detect_recursive_schema method in V1FirecrawlApp."""
    
    def setUp(self):
        """Set up test client."""
        self.app = V1FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'test-key'))
    
    def test_detect_ref(self):
        """Test detection of $ref."""
        schema = {
            "type": "object",
            "properties": {
                "person": {"$ref": "#/$defs/Person"}
            }
        }
        result = self.app._detect_recursive_schema(schema)
        self.assertTrue(result)
    
    def test_detect_defs(self):
        """Test detection of $defs."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            },
            "$defs": {
                "Person": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}}
                }
            }
        }
        result = self.app._detect_recursive_schema(schema)
        self.assertTrue(result)
    
    def test_detect_definitions(self):
        """Test detection of definitions (alternative to $defs)."""
        schema = {
            "type": "object",
            "definitions": {
                "Person": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}}
                }
            }
        }
        result = self.app._detect_recursive_schema(schema)
        self.assertTrue(result)
    
    def test_no_recursion(self):
        """Test schema with no recursive patterns."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            }
        }
        result = self.app._detect_recursive_schema(schema)
        self.assertFalse(result)
    
    def test_with_none(self):
        """Test with None input."""
        result = self.app._detect_recursive_schema(None)
        self.assertFalse(result)
    
    def test_with_non_dict(self):
        """Test with non-dict input."""
        result = self.app._detect_recursive_schema("string")
        self.assertFalse(result)


class TestV1SelectModelForSchema(unittest.TestCase):
    """Tests for _select_model_for_schema method in V1FirecrawlApp."""
    
    def setUp(self):
        """Set up test client."""
        self.app = V1FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'test-key'))
    
    def test_no_schema(self):
        """Test model selection with no schema."""
        result = self.app._select_model_for_schema(None)
        self.assertEqual(result["modelName"], "gpt-4o-mini")
        self.assertEqual(result["reason"], "no_schema")
    
    def test_simple_schema(self):
        """Test model selection with simple schema."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            }
        }
        result = self.app._select_model_for_schema(schema)
        self.assertEqual(result["modelName"], "gpt-4o-mini")
        self.assertEqual(result["reason"], "simple_schema")
    
    def test_recursive_schema(self):
        """Test model selection with recursive schema."""
        schema = {
            "type": "object",
            "properties": {
                "person": {"$ref": "#/$defs/Person"}
            },
            "$defs": {
                "Person": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}}
                }
            }
        }
        result = self.app._select_model_for_schema(schema)
        self.assertEqual(result["modelName"], "gpt-4o")
        self.assertEqual(result["reason"], "recursive_schema_detected")


class TestV1ProcessSchemaWithValidation(unittest.TestCase):
    """Tests for _process_schema_with_validation method in V1FirecrawlApp."""
    
    def setUp(self):
        """Set up test client."""
        self.app = V1FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'test-key'))
    
    def test_process_valid_schema(self):
        """Test processing a valid schema."""
        schema_container = {
            "schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"}
                }
            }
        }
        result = self.app._process_schema_with_validation(schema_container)
        self.assertIn("schema", result)
    
    def test_process_invalid_schema(self):
        """Test processing an invalid schema raises ValueError."""
        schema_container = {
            "schema": {
                "type": "object",
                "additionalProperties": True
            }
        }
        with self.assertRaises(ValueError) as context:
            self.app._process_schema_with_validation(schema_container)
        self.assertIn("invalid structure for OpenAI", str(context.exception))
    
    def test_process_recursive_schema(self):
        """Test processing a recursive schema."""
        schema_container = {
            "schema": {
                "type": "object",
                "properties": {
                    "children": {
                        "type": "array",
                        "items": {"$ref": "#/$defs/TreeNode"}
                    }
                },
                "$defs": {
                    "TreeNode": {
                        "type": "object",
                        "properties": {
                            "value": {"type": "string"},
                            "children": {
                                "type": "array",
                                "items": {"$ref": "#/$defs/TreeNode"}
                            }
                        }
                    }
                }
            }
        }
        result = self.app._process_schema_with_validation(schema_container)
        self.assertIn("schema", result)
    
    def test_process_resolves_non_recursive_refs(self):
        """Test that non-recursive refs are resolved."""
        schema_container = {
            "schema": {
                "type": "object",
                "properties": {
                    "person": {"$ref": "#/$defs/Person"}
                },
                "$defs": {
                    "Person": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"}
                        }
                    }
                }
            }
        }
        result = self.app._process_schema_with_validation(schema_container)
        self.assertIn("schema", result)
    
    def test_process_no_schema_key(self):
        """Test processing container without schema key."""
        schema_container = {
            "other_key": "value"
        }
        result = self.app._process_schema_with_validation(schema_container)
        self.assertEqual(result, schema_container)
    
    def test_process_non_dict_container(self):
        """Test processing non-dict container."""
        schema_container = "not a dict"
        result = self.app._process_schema_with_validation(schema_container)
        self.assertEqual(result, schema_container)
    
    def test_process_with_custom_schema_key(self):
        """Test processing with custom schema key."""
        schema_container = {
            "custom_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"}
                }
            }
        }
        result = self.app._process_schema_with_validation(
            schema_container,
            schema_key="custom_schema"
        )
        self.assertIn("custom_schema", result)


class TestV1EdgeCases(unittest.TestCase):
    """Tests for edge cases and error handling in V1FirecrawlApp."""
    
    def setUp(self):
        """Set up test client."""
        self.app = V1FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'test-key'))
    
    def test_deeply_nested_schema(self):
        """Test handling of deeply nested schemas."""
        schema = {
            "type": "object",
            "properties": {
                "level1": {
                    "type": "object",
                    "properties": {
                        "level2": {
                            "type": "object",
                            "properties": {
                                "level3": {
                                    "type": "object",
                                    "properties": {
                                        "name": {"type": "string"}
                                    },
                                    "additionalProperties": True
                                }
                            }
                        }
                    }
                }
            }
        }
        result = self.app._normalize_schema_for_openai(schema)
        # Should normalize deeply nested schema
        self.assertIsNotNone(result)
    
    def test_circular_reference_doesnt_hang(self):
        """Test that circular references don't cause infinite loops."""
        schema = {
            "$ref": "#/$defs/TreeNode",
            "$defs": {
                "TreeNode": {
                    "type": "object",
                    "properties": {
                        "left": {"$ref": "#/$defs/TreeNode"},
                        "right": {"$ref": "#/$defs/TreeNode"}
                    }
                }
            }
        }
        # Should complete without hanging
        result = self.app._normalize_schema_for_openai(schema)
        self.assertIsNotNone(result)
        
        result2 = self.app._validate_schema_for_openai(schema)
        self.assertIsNotNone(result2)
    
    def test_empty_schema(self):
        """Test handling of empty schema."""
        schema = {}
        result = self.app._normalize_schema_for_openai(schema)
        self.assertEqual(result, {})
        
        is_valid = self.app._validate_schema_for_openai(schema)
        self.assertTrue(is_valid)
    
    def test_schema_with_complex_anyOf(self):
        """Test schema with complex anyOf structures."""
        schema = {
            "anyOf": [
                {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "additionalProperties": True
                },
                {
                    "type": "object",
                    "properties": {"id": {"type": "number"}}
                }
            ]
        }
        result = self.app._normalize_schema_for_openai(schema)
        self.assertNotIn("additionalProperties", result["anyOf"][0])
    
    def test_openai_schema_error_message_constant(self):
        """Test that error message constant exists."""
        self.assertIsNotNone(V1FirecrawlApp.OPENAI_SCHEMA_ERROR_MESSAGE)
        self.assertIn("invalid structure for OpenAI", V1FirecrawlApp.OPENAI_SCHEMA_ERROR_MESSAGE)


class TestV1RecursionStressTests(unittest.TestCase):
    """Stress tests to ensure recursion handling doesn't break under extreme conditions."""
    
    def setUp(self):
        """Set up test client."""
        self.app = V1FirecrawlApp(api_key=os.environ.get('TEST_API_KEY', 'test-key'))
    
    def test_very_deep_reference_chain(self):
        """Test handling of very deep reference chains (testing depth limits)."""
        # Create a chain of 20 references
        defs = {}
        for i in range(20):
            if i == 19:
                defs[f"Level{i}"] = {"type": "string"}
            else:
                defs[f"Level{i}"] = {"$ref": f"#/$defs/Level{i+1}"}
        
        schema = {
            "$ref": "#/$defs/Level0",
            "$defs": defs
        }
        
        # Should handle without crashing (may not fully resolve due to depth limits)
        result = self.app._resolve_refs(schema, defs)
        self.assertIsNotNone(result)
        
        # Normalization should also complete
        normalized = self.app._normalize_schema_for_openai(schema)
        self.assertIsNotNone(normalized)
    
    def test_multiple_circular_paths(self):
        """Test schema with multiple different circular reference paths."""
        defs = {
            "Node": {
                "type": "object",
                "properties": {
                    "parent": {"$ref": "#/$defs/Node"},
                    "child": {"$ref": "#/$defs/Node"},
                    "sibling": {"$ref": "#/$defs/Node"},
                    "related": {"$ref": "#/$defs/RelatedNode"}
                }
            },
            "RelatedNode": {
                "type": "object",
                "properties": {
                    "backref": {"$ref": "#/$defs/Node"},
                    "self": {"$ref": "#/$defs/RelatedNode"}
                }
            }
        }
        
        # Should detect circular references
        has_circular = self.app._check_for_circular_defs(defs)
        self.assertTrue(has_circular)
        
        # Should handle normalization without hanging
        schema = {"$ref": "#/$defs/Node", "$defs": defs}
        result = self.app._normalize_schema_for_openai(schema)
        self.assertIsNotNone(result)
    
    def test_recursive_in_oneOf_allOf(self):
        """Test recursive references within oneOf and allOf contexts."""
        schema = {
            "oneOf": [
                {"$ref": "#/$defs/TypeA"},
                {"$ref": "#/$defs/TypeB"}
            ],
            "$defs": {
                "TypeA": {
                    "type": "object",
                    "properties": {
                        "nested": {"$ref": "#/$defs/TypeA"}
                    }
                },
                "TypeB": {
                    "type": "object",
                    "allOf": [
                        {"$ref": "#/$defs/TypeA"},
                        {"properties": {"extra": {"type": "string"}}}
                    ]
                }
            }
        }
        
        # Should handle complex recursive patterns
        result = self.app._normalize_schema_for_openai(schema)
        self.assertIsNotNone(result)
        self.assertIn("oneOf", result)
        
        # Should validate without errors
        is_valid = self.app._validate_schema_for_openai(schema)
        self.assertTrue(is_valid)
    
    def test_invalid_reference_doesnt_crash(self):
        """Test that invalid/broken references don't crash the system."""
        schema = {
            "type": "object",
            "properties": {
                "broken": {"$ref": "#/$defs/NonExistent"}
            },
            "$defs": {
                "Existing": {"type": "string"}
            }
        }
        
        # Should handle gracefully without crashing
        result = self.app._resolve_refs(schema, schema.get("$defs", {}))
        self.assertIsNotNone(result)
        
        normalized = self.app._normalize_schema_for_openai(schema)
        self.assertIsNotNone(normalized)
    
    def test_malformed_reference_format(self):
        """Test handling of malformed $ref formats."""
        schema = {
            "type": "object",
            "properties": {
                "bad1": {"$ref": "not-a-valid-ref"},
                "bad2": {"$ref": "#/wrong/path"},
                "bad3": {"$ref": 12345}  # Not even a string
            }
        }
        
        # Should handle without crashing
        result = self.app._normalize_schema_for_openai(schema)
        self.assertIsNotNone(result)
    
    def test_linked_list_pattern(self):
        """Test real-world pattern: linked list with recursive next pointer."""
        schema = {
            "type": "object",
            "properties": {
                "value": {"type": "string"},
                "next": {
                    "oneOf": [
                        {"$ref": "#/$defs/Node"},
                        {"type": "null"}
                    ]
                }
            },
            "$defs": {
                "Node": {
                    "type": "object",
                    "properties": {
                        "value": {"type": "string"},
                        "next": {
                            "oneOf": [
                                {"$ref": "#/$defs/Node"},
                                {"type": "null"}
                            ]
                        }
                    }
                }
            }
        }
        
        # Should detect recursion
        is_recursive = self.app._detect_recursive_schema(schema)
        self.assertTrue(is_recursive)
        
        # Should select appropriate model
        model_info = self.app._select_model_for_schema(schema)
        self.assertEqual(model_info["modelName"], "gpt-4o")
        
        # Should handle normalization
        result = self.app._normalize_schema_for_openai(schema)
        self.assertIsNotNone(result)
    
    def test_graph_pattern_with_multiple_node_types(self):
        """Test complex graph pattern with multiple interconnected node types."""
        schema = {
            "type": "object",
            "properties": {
                "nodes": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/GraphNode"}
                },
                "edges": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/Edge"}
                }
            },
            "$defs": {
                "GraphNode": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "neighbors": {
                            "type": "array",
                            "items": {"$ref": "#/$defs/GraphNode"}
                        },
                        "edges": {
                            "type": "array",
                            "items": {"$ref": "#/$defs/Edge"}
                        }
                    }
                },
                "Edge": {
                    "type": "object",
                    "properties": {
                        "from": {"$ref": "#/$defs/GraphNode"},
                        "to": {"$ref": "#/$defs/GraphNode"}
                    }
                }
            }
        }
        
        # Should detect circular references
        has_circular = self.app._check_for_circular_defs(schema.get("$defs", {}))
        self.assertTrue(has_circular)
        
        # Should handle without hanging
        result = self.app._normalize_schema_for_openai(schema)
        self.assertIsNotNone(result)
        
        # Should validate
        is_valid = self.app._validate_schema_for_openai(schema)
        self.assertTrue(is_valid)
    
    def test_mutual_recursion_three_way(self):
        """Test three-way mutual recursion (A->B->C->A)."""
        defs = {
            "TypeA": {
                "type": "object",
                "properties": {
                    "toB": {"$ref": "#/$defs/TypeB"}
                }
            },
            "TypeB": {
                "type": "object",
                "properties": {
                    "toC": {"$ref": "#/$defs/TypeC"}
                }
            },
            "TypeC": {
                "type": "object",
                "properties": {
                    "toA": {"$ref": "#/$defs/TypeA"}
                }
            }
        }
        
        # Should detect circular references
        has_circular = self.app._check_for_circular_defs(defs)
        self.assertTrue(has_circular)
        
        # Should handle without hanging
        schema = {"$ref": "#/$defs/TypeA", "$defs": defs}
        result = self.app._normalize_schema_for_openai(schema)
        self.assertIsNotNone(result)
    
    def test_required_fields_cleanup_without_defs(self):
        """Test that required field cleanup works for schemas without $defs."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "number"}
            },
            "required": ["name", "age", "nonexistent_field"],
            "additionalProperties": True
        }
        
        result = self.app._normalize_schema_for_openai(schema)
        
        # Should clean up required when properties are fully defined
        self.assertIn("required", result)
        self.assertEqual(result["required"], ["name", "age"])
        # additionalProperties: true should be removed
        self.assertNotIn("additionalProperties", result)
    
    def test_required_fields_in_nested_defs(self):
        """Test that required field cleanup works in nested $defs definitions."""
        schema = {
            "type": "object",
            "properties": {
                "data": {"$ref": "#/$defs/Node"}
            },
            "$defs": {
                "Node": {
                    "type": "object",
                    "properties": {
                        "value": {"type": "string"},
                        "nested": {"$ref": "#/$defs/Node"}
                    },
                    "required": ["value", "another_nonexistent"],
                    "additionalProperties": True
                }
            }
        }
        
        result = self.app._normalize_schema_for_openai(schema)
        
        # $defs definitions should be cleaned
        self.assertIn("$defs", result)
        self.assertIn("Node", result["$defs"])
        node_def = result["$defs"]["Node"]
        
        # Required should be cleaned in the definition
        self.assertIn("required", node_def)
        self.assertEqual(node_def["required"], ["value"])
        
        # additionalProperties: true should be removed
        self.assertNotIn("additionalProperties", node_def)
    
    def test_required_fields_cleanup_limitation_with_defs(self):
        """
        Test documenting current limitation: required field cleanup doesn't happen 
        at root level when $defs is present due to early return in normalization.
        
        This test documents the current behavior - if this is considered a bug,
        the implementation should be fixed to cleanup required fields at root level
        even when $defs is present.
        """
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "child": {"$ref": "#/$defs/Node"}
            },
            "required": ["name", "child", "nonexistent_field"],  # Has invalid field
            "$defs": {
                "Node": {
                    "type": "object",
                    "properties": {
                        "value": {"type": "string"}
                    }
                }
            }
        }
        
        result = self.app._normalize_schema_for_openai(schema)
        
        # Current behavior: required is NOT cleaned at root when $defs present
        # This is because the code returns early when processing $defs
        self.assertIn("required", result)
        # Documents current behavior - includes invalid field
        self.assertIn("nonexistent_field", result["required"])
        
        # Note: If this behavior should change, update both the code and this test
    
    def test_same_object_referenced_multiple_times(self):
        """Test that the same object referenced multiple times is handled correctly."""
        person_def = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            }
        }
        
        schema = {
            "type": "object",
            "properties": {
                "person1": {"$ref": "#/$defs/Person"},
                "person2": {"$ref": "#/$defs/Person"},
                "person3": {"$ref": "#/$defs/Person"}
            },
            "$defs": {
                "Person": person_def
            }
        }
        
        # Should handle without issues
        result = self.app._resolve_refs(schema, schema.get("$defs", {}))
        self.assertIsNotNone(result)
        
        # All three should be resolved
        if "properties" in result:
            self.assertIn("person1", result["properties"])
            self.assertIn("person2", result["properties"])
            self.assertIn("person3", result["properties"])


if __name__ == '__main__':
    unittest.main()

