import { transformArrayToObject } from "../extract/helpers/transform-array-to-obj";

const originalSchema = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
};

describe("transformArrayToObject function", () => {
  it("shoud transform array to object (id: 26)", async () => {
    const res1 = {
      products: [
        {
          name: "סיר Neon 1",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res2 = {
      products: [
        {
          name: "סיר Neon 2",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res3 = {
      products: [
        {
          name: "סיר Neon 3",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res4 = {
      products: [
        {
          name: "סיר Neon 4",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res5 = {
      products: [
        {
          name: "סיר Neon 5",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res6 = {
      products: [
        {
          name: "סיר Neon 6",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res7 = {
      products: [
        {
          name: "סיר Neon 7",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const results = [res1, res2, res3, res4, res5, res6, res7];

    const multiEntityResult = {
      products: [
        {
          name: "סיר Neon 1",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon 2",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon 3",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon 4",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon 5",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon 6",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon 7",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    expect(await transformArrayToObject(originalSchema, results)).toEqual(
      multiEntityResult,
    );
  });

  it("should transform array to object (id: 27)", async () => {
    const res1 = {
      products: [
        {
          name: "סיר Neon 1",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res3 = { products: [] };
    const res4 = { products: null };

    const results = [res1, res3, res4];

    const multiEntityResult = {
      products: [
        {
          name: "סיר Neon 1",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    expect(await transformArrayToObject(originalSchema, results)).toEqual(
      multiEntityResult,
    );
  });

  it("should transform array to object (id: 27)", async () => {
    const res1 = {
      products: [
        {
          name: "סיר Neon 1",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res3 = { products: [] };
    const res4 = {
      products: [
        {
          name: "סיר Neon 4",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const results = [res1, res3, res4];

    const multiEntityResult = {
      products: [
        {
          name: "סיר Neon 1",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon 4",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    expect(await transformArrayToObject(originalSchema, results)).toEqual(
      multiEntityResult,
    );
  });

  it("more complex schema", async () => {
    const originalSchema = {
      type: "object",
      properties: {
        ecommerce: {
          type: "object",
          properties: {
            name: { type: "string" },
            products: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  price: { type: "string" },
                  description: { type: "string" },
                  categories: {
                    type: "array",
                    items: {
                      type: "string",
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const res1 = {
      ecommerce: {
        name: "1",
        products: [
          {
            name: "סיר Neon 1",
            price: "99.90 ₪",
            description: "",
            categories: ["סירים", "something", "else"],
          },
        ],
      },
    };
    const res2 = {
      ecommerce: {
        name: "keep the first",
        products: [
          {
            name: "סיר Neon 2",
            price: "99.90 ₪",
            description: "",
            categories: ["סירים", "ajkshda", "something", "else"],
          },
        ],
      },
    };

    const res3 = { ecommerce: { products: [] } };
    const res4 = { ecommerce: { products: null } };

    const results = [res1, res2, res3, res4];

    const multiEntityResult = {
      ecommerce: {
        name: "1",
        products: [
          {
            name: "סיר Neon 1",
            price: "99.90 ₪",
            description: "",
            categories: ["סירים", "something", "else"],
          },
          {
            name: "סיר Neon 2",
            price: "99.90 ₪",
            description: "",
            categories: ["סירים", "ajkshda", "something", "else"],
          },
        ],
      },
    };

    console.log(await transformArrayToObject(originalSchema, results));

    expect(await transformArrayToObject(originalSchema, results)).toEqual(
      multiEntityResult,
    );
  });

  it("even more complex schema", async () => {
    const moreComplexSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        products: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              price: { type: "string" },
              description: { type: "string" },
            },
          },
        },
        categories: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
    };

    const res1 = {
      name: "1",
      description: "description",
      products: [
        {
          name: "Neon 1",
          price: "99.90 ₪",
          description: "neon 1 product",
        },
      ],
      categories: ["something", "else"],
    };

    const res2 = {
      name: "keep first",
      description: "description",
      products: [
        {
          name: "Neon 2",
          price: "99.90 ₪",
          description: "neon 2 product",
        },
      ],
      categories: ["something"],
    };

    const res3 = {
      name: "keep the first",
      products: [
        {
          name: "Neon 3",
          price: "555.90 ₪",
          description: "neon 3 product",
        },
      ],
      categories: ["hey", "something", "other one"],
    };

    const results = [res1, res2, res3];

    const multiEntityResult = {
      name: "1",
      description: "description",
      products: [
        {
          name: "Neon 1",
          price: "99.90 ₪",
          description: "neon 1 product",
        },
        {
          name: "Neon 2",
          price: "99.90 ₪",
          description: "neon 2 product",
        },
        {
          name: "Neon 3",
          price: "555.90 ₪",
          description: "neon 3 product",
        },
      ],
      categories: ["something", "else", "hey", "other one"],
    };

    console.log(
      multiEntityResult,
      await transformArrayToObject(moreComplexSchema, results),
    );

    expect(await transformArrayToObject(moreComplexSchema, results)).toEqual(
      multiEntityResult,
    );
  });

  it("should transform array to object (id: 7)", async () => {
    const originalSchema = {
      type: "object",
      properties: {
        property_details: {
          properties: {
            title: {
              title: "Title",
              type: "string",
            },
            location: {
              title: "Location",
              type: "string",
            },
            property_type: {
              title: "Property Type",
              type: "string",
            },
            size: {
              title: "Size",
              type: "string",
            },
            rooms: {
              title: "Rooms",
              type: "string",
            },
            floor: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Floor",
            },
            furnished: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Furnished",
            },
            energy_rating: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Energy Rating",
            },
          },
          required: [
            "title",
            "location",
            "property_type",
            "size",
            "rooms",
            "floor",
            "furnished",
            "energy_rating",
          ],
          title: "PropertyDetails",
          type: "object",
        },
        features: {
          properties: {
            pets_allowed: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Pets Allowed",
            },
            senior_friendly: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Senior Friendly",
            },
            balcony: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Balcony",
            },
            dishwasher: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Dishwasher",
            },
            parking: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Parking",
            },
            electric_charging: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Electric Charging",
            },
            elevator: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Elevator",
            },
            washer_dryer: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Washer Dryer",
            },
          },
          required: [
            "pets_allowed",
            "senior_friendly",
            "balcony",
            "dishwasher",
            "parking",
            "electric_charging",
            "elevator",
            "washer_dryer",
          ],
          title: "FeaturesAmenities",
          type: "object",
        },
        rental_details: {
          properties: {
            monthly_net_rent: {
              title: "Monthly Net Rent",
              type: "string",
            },
            utilities: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Utilities",
            },
            move_in_price: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Move In Price",
            },
            deposit: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Deposit",
            },
            prepaid_rent: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Prepaid Rent",
            },
            rental_period: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Rental Period",
            },
            available_from: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Available From",
            },
            listing_id: {
              title: "Listing Id",
              type: "string",
            },
          },
          required: [
            "monthly_net_rent",
            "utilities",
            "move_in_price",
            "deposit",
            "prepaid_rent",
            "rental_period",
            "available_from",
            "listing_id",
          ],
          title: "RentalDetails",
          type: "object",
        },
        landlord_status: {
          properties: {
            boligportal_approved: {
              anyOf: [{ type: "boolean" }, { type: "null" }],
              title: "Boligportal Approved",
            },
            number_of_ads: {
              anyOf: [{ type: "integer" }, { type: "null" }],
              title: "Number Of Ads",
            },
            last_active: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Last Active",
            },
            profile_created: {
              anyOf: [{ type: "string" }, { type: "null" }],
              title: "Profile Created",
            },
          },
          required: [
            "boligportal_approved",
            "number_of_ads",
            "last_active",
            "profile_created",
          ],
          title: "LandlordStatus",
          type: "object",
        },
      },
    };

    const results = [
      {
        property_details: {
          title: "3 room apartment on 70 m²",
          location: "Odense",
          property_type: "Apartment",
          size: "70 m²",
          rooms: "3",
          floor: null,
          furnished: null,
          energy_rating: null,
        },
        features: {
          pets_allowed: null,
          senior_friendly: null,
          balcony: null,
          dishwasher: null,
          parking: null,
          electric_charging: null,
          elevator: null,
          washer_dryer: null,
        },
        rental_details: {
          monthly_net_rent: "7,000 kr.",
          utilities: null,
          move_in_price: null,
          deposit: null,
          prepaid_rent: null,
          rental_period: null,
          available_from: null,
          listing_id: "4937446",
        },
        landlord_status: {
          boligportal_approved: null,
          number_of_ads: null,
          last_active: null,
          profile_created: null,
        },
      },
    ];

    expect(await transformArrayToObject(originalSchema, results)).toEqual(
      results[0],
    );
  });
});
