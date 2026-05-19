// ============================================================
// Customer.Partial.cs — YOUR customizations (never overwritten)
// ============================================================
// Keep all business logic, computed properties, and domain methods
// in this file. It survives every `dotnet ef dbcontext scaffold --force`.

public partial class Customer
{
    /// <summary>Display name combining name and email.</summary>
    public string DisplayName => Email is not null
        ? $"{Name} <{Email}>"
        : Name;

    /// <summary>True when the customer has placed at least one order.</summary>
    public bool HasOrders => Orders.Count > 0;

    /// <summary>Validates domain invariants.</summary>
    /// <exception cref="InvalidOperationException">Thrown when invariants are violated.</exception>
    public void EnsureValid()
    {
        if (string.IsNullOrWhiteSpace(Name))
            throw new InvalidOperationException("Customer name cannot be empty.");

        if (string.IsNullOrWhiteSpace(Region))
            throw new InvalidOperationException("Region is required.");
    }
}
