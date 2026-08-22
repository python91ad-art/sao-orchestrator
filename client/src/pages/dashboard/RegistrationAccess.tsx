import React, { useState } from 'react';
import { trpc } from '../../lib/trpc';
import { useAuth } from '../../hooks/useAuth';
import { format } from 'date-fns';

const RegistrationAccess: React.FC = () => {
  const { user } = useAuth();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [expiresAt, setExpiresAt] = useState('');

  // Queries & mutations
  const utils = trpc.useContext();
  const listQuery = trpc.invites.list.useQuery({ limit: 100, offset: 0 });
  const createMutation = trpc.invites.create.useMutation({
    onSuccess: () => {
      utils.invites.list.invalidate();
      setEmail('');
      setRole('user');
      setExpiresAt('');
    },
  });
  const deleteMutation = trpc.invites.delete.useMutation({
    onSuccess: () => utils.invites.list.invalidate(),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({
      email,
      role,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });
  };

  const handleDelete = (id: string) => {
    if (window.confirm('Delete this invitation?')) {
      deleteMutation.mutate({ id });
    }
  };

  // Only admins can see this page
  if (user?.role !== 'admin') {
    return (
      <div className="flex justify-center items-center h-[50vh]">
        <p className="text-neutral-400">Access denied. Administrators only.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-white">Registration Access</h2>
        <p className="text-sm text-neutral-400">
          Authorize email addresses to register for SAO. Invitations are single‑use.
        </p>
      </div>

      {/* Create Invitation Form */}
      <div className="card-bold">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="sao@example.com"
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                Role
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as 'admin' | 'user')}
                className="w-full"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                Expires At (optional)
              </label>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full"
              />
            </div>
          </div>
          <div>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="btn-bold-primary"
            >
              {createMutation.isPending ? 'Authorizing...' : 'Authorize Registration'}
            </button>
          </div>
          {createMutation.error && (
            <p className="text-sm text-red-400">{createMutation.error.message}</p>
          )}
        </form>
      </div>

      {/* Existing Invitations Table */}
      <div className="card-bold">
        <h3 className="text-lg font-bold text-white mb-4">Authorized Registrations</h3>
        {listQuery.isPending ? (
          <div className="spinner"></div>
        ) : listQuery.data && listQuery.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Created At</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {listQuery.data.map((invite) => {
                  const isUsed = !!invite.usedAt;
                  const isExpired = invite.expiresAt && new Date(invite.expiresAt) < new Date();
                  const status = isUsed ? 'Used' : isExpired ? 'Expired' : 'Active';

                  return (
                    <tr key={invite.id}>
                      <td>{invite.email}</td>
                      <td>
                        <span className={`badge-${invite.role === 'admin' ? 'primary' : 'gray'}`}>
                          {invite.role}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`badge-${
                            status === 'Active'
                              ? 'success'
                              : status === 'Used'
                              ? 'warning'
                              : 'danger'
                          }`}
                        >
                          {status}
                        </span>
                      </td>
                      <td className="text-xs text-neutral-400">
                        {format(new Date(invite.createdAt), 'PPp')}
                      </td>
                      <td>
                        <button
                          onClick={() => handleDelete(invite.id)}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors"
                          disabled={deleteMutation.isPending}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-neutral-400">No invitations have been created.</p>
        )}
      </div>
    </div>
  );
};

export default RegistrationAccess;
