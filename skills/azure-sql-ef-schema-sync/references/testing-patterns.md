# Unit Test Update Patterns

After an Azure SQL schema change, unit tests break in predictable ways. This guide covers each pattern.

## Strategy: Repository Pattern (Recommended)

If the codebase uses the repository pattern, schema changes are isolated to:
1. The entity class (generated)
2. The repository implementation
3. Test data builders

Controllers, services, and most tests mock the repository — they don't care about the DB schema directly.

```csharp
// Service test — doesn't know about DB columns at all
_mockRepo.Setup(r => r.GetByIdAsync(1, ct)).ReturnsAsync(new Customer { Id = 1, Name = "Acme" });
```

If columns are added/removed, only update the `new Customer { }` initializer in tests.

---

## Pattern 1: Object Initializer Updates

The most common test failure after a schema change.

### Column Added (Non-Nullable)

```csharp
// BEFORE — fails to compile: 'Region' is required
var customer = new Customer { Id = 1, Name = "Acme" };

// AFTER — supply the new required column
var customer = new Customer { Id = 1, Name = "Acme", Region = "US" };
```

### Column Added (Nullable)

No compile error, but tests may fail if assertions check serialized output or row counts.

```csharp
// Explicit null is fine, but add it for clarity
var customer = new Customer { Id = 1, Name = "Acme", Region = null };
```

### Column Removed

```csharp
// BEFORE — fails: 'LegacyCode' no longer exists
var customer = new Customer { Id = 1, Name = "Acme", LegacyCode = "X001" };

// AFTER — remove the deleted property
var customer = new Customer { Id = 1, Name = "Acme" };
```

---

## Pattern 2: Test Data Builders / Fixtures

Centralise object construction so schema changes require one fix, not fifty:

```csharp
// CustomerBuilder.cs — fix here once, all tests benefit
public class CustomerBuilder
{
    private int _id = 1;
    private string _name = "Test Customer";
    private string _region = "US";          // <-- add new column here

    public CustomerBuilder WithId(int id) { _id = id; return this; }
    public CustomerBuilder WithName(string name) { _name = name; return this; }
    public CustomerBuilder WithRegion(string region) { _region = region; return this; }

    public Customer Build() => new Customer
    {
        Id = _id,
        Name = _name,
        Region = _region   // <-- add here
    };
}

// Test
var customer = new CustomerBuilder().WithName("Acme").Build();
```

---

## Pattern 3: InMemory / SQLite Test Database Seeding

If tests use EF Core's InMemory provider or SQLite:

```csharp
// Arrange
var options = new DbContextOptionsBuilder<AppDbContext>()
    .UseInMemoryDatabase(databaseName: Guid.NewGuid().ToString())
    .Options;

using var context = new AppDbContext(options);

// Seed — must include ALL required (non-nullable) columns after schema change
context.Customers.AddRange(
    new Customer { Id = 1, Name = "Acme", Region = "US" },    // added Region
    new Customer { Id = 2, Name = "Globex", Region = "EU" }
);
context.SaveChanges();
```

---

## Pattern 4: Mock Repository Returns

When tests mock an `ICustomerRepository`, update the returned objects:

```csharp
// BEFORE
_mockRepo.Setup(r => r.GetAllAsync(It.IsAny<CancellationToken>()))
    .ReturnsAsync(new List<Customer>
    {
        new Customer { Id = 1, Name = "Acme" }
    });

// AFTER — new column added
_mockRepo.Setup(r => r.GetAllAsync(It.IsAny<CancellationToken>()))
    .ReturnsAsync(new List<Customer>
    {
        new Customer { Id = 1, Name = "Acme", Region = "US" }
    });
```

---

## Pattern 5: Assertion Updates

### New Column — Assert Its Value

```csharp
// Add assertion for the new column if it maps to a DTO
result.Region.Should().Be("US");
```

### Removed Column — Remove Assertion

```csharp
// REMOVE this line — property no longer exists
result.LegacyCode.Should().Be("X001");
```

### Relation Added — Assert Navigation

```csharp
// If a new navigation property was added
result.Orders.Should().HaveCount(2);
result.Orders.First().Total.Should().Be(100m);
```

### Relation Removed — Remove Navigation Assertions

```csharp
// REMOVE: OldDepartment navigation was dropped
result.OldDepartment.Should().NotBeNull();
```

---

## Pattern 6: Integration Tests with Real DB

If the solution has integration tests hitting a real Azure SQL instance:

```csharp
// After schema change, re-run migrations or re-scaffold test DB
// Ensure the test DB is in sync with the updated schema:

// Option A: migrations-first
dotnet ef database update --project <DbProject> --startup-project <ApiProject>

// Option B: recreate test DB from scratch
dotnet ef database drop --force
dotnet ef database update
```

---

## Finding All Tests That Need Updates

```powershell
# Find all test files referencing the entity
Get-ChildItem -Recurse -Filter "*.cs" -Path "**Tests**" |
    Select-String "new Customer\s*\{" |
    Select-Object Path, LineNumber, Line

# Find assertion lines for removed column
Get-ChildItem -Recurse -Filter "*.cs" |
    Select-String "\.LegacyCode" |
    Select-Object Path, LineNumber, Line
```

---

## Recommended Test Naming After Changes

New tests for the new column should follow the project convention:

```
MethodName_Scenario_ExpectedResult

GetCustomerById_WhenRegionIsNull_ReturnsCustomerWithNullRegion
CreateCustomer_WhenRegionMissing_ThrowsValidationException
```
